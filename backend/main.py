"""
T₂ Calculator — FastAPI Backend
--------------------------------
Accepts .cif file uploads, parses them with pymatgen,
and returns structure info + computed T₂ coherence time.

Usage:
    uvicorn main:app --reload
"""

import io
import os
import tempfile
import logging
from pathlib import Path

import pandas as pd
import numpy as np
import scipy.special as special

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# pymatgen imports
try:
    from pymatgen.core import Structure
    from pymatgen.io.cif import CifParser
    from pymatgen.symmetry.analyzer import SpacegroupAnalyzer
except ImportError as e:
    raise ImportError(
        "pymatgen is required. Install it with: pip install pymatgen"
    ) from e

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
logger = logging.getLogger(__name__)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="T₂ Calculator API",
    description="Parses CIF crystal structures and computes spin coherence time T₂.",
    version="1.0.0",
)

# ── CORS ──────────────────────────────────────────────────────────────────────
# Add your GitHub Pages domain here once deployed, e.g.:
# "https://your-username.github.io"
ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "http://127.0.0.1:8080",
    "http://localhost:8080",
    "https://mathtoriyama.github.io/t2-calculator/",
    # Add your GitHub Pages URL here:
    # "https://your-username.github.io",
]

# For development convenience, allow all origins.
# In production, restrict to ALLOWED_ORIGINS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],           # ← Tighten this in production
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ── Constants ─────────────────────────────────────────────────────────────────
MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024   # 10 MB
ALLOWED_EXTENSION   = ".cif"


# ── Response Schema ───────────────────────────────────────────────────────────
class LatticeParameters(BaseModel):
    a: float
    b: float
    c: float
    alpha: float
    beta: float
    gamma: float
    volume: float


class ComputeResponse(BaseModel):
    chemical_formula: str
    reduced_formula:  str
    num_atoms:        int
    num_sites:        int
    lattice_parameters: LatticeParameters
    crystal_system:   str
    space_group:      str
    space_group_number: int
    density:          float        # g/cm³
    T2:               float | None  # seconds (None if compute_T2 not yet implemented)
    T2_unit:          str


# ── T₂ Computation ────────────────────────────────────────────────────────────
__location__ = os.path.realpath(os.path.join(os.getcwd(), os.path.dirname(__file__)))
all_spins = pd.read_csv(os.path.join(__location__, 'isotopes.txt'), 
                        sep='\s+', 
                        header=None, 
                        comment='%',
                        names=['protons', 'nucleons', 'radioactive', 'symbol', 'name', 'spin', 'g', 'conc', 'q'])
vdW_radii_filedata = open(os.path.join(__location__, 'vdW_Radii.csv')).readlines()


def gamma_custom(x):
    if x >= 0:
        return special.gamma(x)
    elif x < 0:
        return 1./x * gamma_custom(x+1)

def H(p):
    return p * (-gamma_custom(-p/2) / 2**(p/2 + 1))

def Area(D):
    return np.pi**(D/2) / special.gamma(D/2 + 1)



# Calculate the T2 value of an element
def T2_Kanai_Element(n_3D, g, I):
    #T2_Eq2 = 1.5e18 * np.abs(g)**(-1.6) * I**(-1.1) * (n_3D)**(-1.0)
    T2_Eq2 = 1.46e18 * np.abs(g)**(-1.64) * I**(-1.1) * (n_3D)**(-1.0)    
    return T2_Eq2


# Calculate T2 of a compound (input: list of T2 of each element)
def T2_Kanai(T2_list: list, exp: float):
    T2_values = np.array(T2_list)
    T2_combined = np.sum( T2_values**(-exp) )**(-1./exp)
    return T2_combined #**(2./3)


# Calculate the thickness of the 2D/monolayer material
def Get_Thickness(structure):

    # Get van der Waals radii
    vdW_radii = {}
    #for line in open("/mnt/c/Users/Michael/OneDrive - The University of Chicago/Documents/2D_Host_Substrates/Manuscript/Zenodo_Entry/v1.0.1/Scripts/Tools/vdW_Radii.csv").readlines():
    for line in vdW_radii_filedata:
        line = line.split(",")
        vdW_radii[line[0]] = float(line[1])

    # Get positions and vdW radii of all atoms in the structure
    positions = []
    vdW_radii_structure = []
    for atom in structure.sites:
        positions.append(atom.coords)
        vdW_radii_structure.append(vdW_radii[atom.specie.symbol])
    positions = np.asarray(positions)
    vdW_radii_structure = np.asarray(vdW_radii_structure)

    # Get maximum z-distance between atom centers
    max_z_dist = np.max(positions[:,2]) - np.min(positions[:,2])

    # If the material is 1-atom thick (i.e. a true 2D material), then define "thickness" as the largest vdW diameter
    if max_z_dist == 0.0:
        print("True 2D")
        return 2*np.max(vdW_radii_structure) * 1e-8

    # Add van der Waals radii to max z distance for 3D thickness, otherwise return z-distance
    thickness = max_z_dist + vdW_radii_structure[np.argmax(positions[:,2])] + vdW_radii_structure[np.argmin(positions[:,2])]
    
    return thickness * 1e-8


def Get_Volume(structure):

    # Calculate volume of the 2D material
    lat_vec_a = structure.lattice.matrix[0]
    lat_vec_b = structure.lattice.matrix[1]
    area = np.linalg.norm(np.cross(lat_vec_a, lat_vec_b)) * 1e-16
    thickness = Get_Thickness(structure)
    volume = area * thickness

    return volume


# Calculate nuclear spin density of an element, from its natural abundance and the structure
def Get_NuclearSpinDensity(natural_abundance_percent, structure, atom_type):
    
    # Calculate volume of the 2D material
    volume = Get_Volume(structure)

    # Count atoms of specified type in structure
    count = 0
    for atom in structure.sites:
        if atom.specie.symbol == atom_type:
            count += 1

    # Get number density of element in the structure
    number_density = count / volume

    return number_density * (natural_abundance_percent/100)


def Compute_T2_2D(struc: Structure) -> float:
    """
    Calculate the T2 time for a 2D material, considering all atom types.

    Parameters
    ----------
    struc : pymatgen.core.Structure
        Fully parsed crystal structure.

    Returns
    -------
    float
        T2 value in **ms**.
    """

    alpha_2D = 2.84 
    eta_3D = 1.5
    
    # Get elements (not species, which can have charge)
    elements = [str(specie) for specie in struc.composition.element_composition]

    T2_elems = []
    for element in set(elements):
        df_elem = all_spins[all_spins["symbol"] == element]
        for i, row in df_elem.iterrows():

            # Get relevant isotope data
            abun_perc = row["conc"]
            n_3D = Get_NuclearSpinDensity(abun_perc, struc, element)
            g = row["g"]
            I = row["spin"]

            # Check whether any are zero
            if np.any(np.array([n_3D,g,I]) == 0.0): continue

            # Calculate T2 of element
            T2_elem_3D = T2_Kanai_Element(n_3D, g, I)

            factor_3D = ( Area(3) * n_3D * H(p=eta_3D*2./3) )**(1./eta_3D)
            factor_2D = ( Area(2) * n_3D * Get_Thickness(struc) * H(p=2./alpha_2D) )**(alpha_2D/3)
            T2_elem_2D = T2_elem_3D * factor_3D / factor_2D

            T2_elems.append(T2_elem_2D)

    # Calculate T2 of compound
    T2_comp = T2_Kanai(T2_elems, exp=3./alpha_2D)
    T2_comp *= 1000  # Unit conversion, from s to ms

    return T2_comp



# ====================================================================
# Functions specifically for 3D structures
# ====================================================================

# Calculate nuclear spin density of an element, from its natural abundance and the structure
def Get_NuclearSpinDensity_3D(natural_abundance_percent, structure, atom_type):
    
    # Calculate volume of the 2D material
    volume = structure.volume * 1e-24

    # Count atoms of specified type in structure
    count = 0
    for atom in structure.sites:
        if atom.specie.symbol == atom_type:
            count += 1

    # Get number density of element in the structure
    number_density = count / volume

    return number_density * (natural_abundance_percent/100)



# Calculate the T2 value of an element (3D)
def T2_Kanai_Element_3D(n_3D, g, I):
    #T2_Eq2 = 1.5e18 * np.abs(g)**(-1.6) * I**(-1.1) * (n_3D)**(-1.0)
    T2_Eq2 = 1.50e18 * np.abs(g)**(-1.65) * I**(-1.09) * (n_3D)**(-1.0)    
    return T2_Eq2


def Compute_T2_3D(struc: Structure) -> float:
    """
    Calculate the T2 time for a 3D material, considering all atom types.

    Parameters
    ----------
    struc : pymatgen.core.Structure
        Fully parsed crystal structure.

    Returns
    -------
    float
        T2 value in **ms**.
    """

    # Get elements (not species, which can have charge)
    elements = [str(specie) for specie in struc.composition.element_composition]

    T2_elems = []    
    for element in set(elements):
        df_elem = all_spins[all_spins["symbol"] == element]
        for i, row in df_elem.iterrows():

            # Get relevant isotope data
            abun_perc = row["conc"]
            n_3D = Get_NuclearSpinDensity_3D(abun_perc, struc, element)
            g = row["g"]
            I = row["spin"]

            # Check whether any are zero
            if np.any(np.array([n_3D,g,I]) == 0.0): continue

            # Calculate T2 of element
            #T2_elem_3D = T2_Kanai_Element(n_3D, g, I)
            T2_elem_3D = T2_Kanai_Element_3D(n_3D, g, I)

            T2_elems.append(T2_elem_3D)

    # Calculate T2 of compound
    T2_comp = T2_Kanai(T2_elems, exp=2)
    T2_comp *= 1000  # Unit conversion, from s to ms

    return T2_comp



# ====================================================================
# Functions specifically for heterostructures
# ====================================================================

def Compute_T2_Heterostructure(struc_2d: Structure, struc_3d: Structure) -> float:
    """
    Calculate the T2 time for a heterostructure.

    Parameters
    ----------
    struc_2d, struc_3d : pymatgen.core.Structure
        Fully parsed crystal structure.

    Returns
    -------
    float
        T2 value in **ms**.
    """
    t2_2d = Compute_T2_2D(struc_2d)
    t2_3d = Compute_T2_3D(struc_3d)
    t2_HS = ( t2_2d**(-1.06) + t2_3d**(-1.5) / 2 )**(-1 / 1.35)
    return t2_HS



# ── Utility Helpers ───────────────────────────────────────────────────────────
def validate_upload(file: UploadFile, content: bytes) -> None:
    """Raise HTTPException if the file fails validation."""
    # Extension check
    suffix = Path(file.filename or "").suffix.lower()
    if suffix != ALLOWED_EXTENSION:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type '{suffix}'. Only {ALLOWED_EXTENSION} files are accepted.",
        )
    # Size check
    if len(content) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({len(content) / 1024 / 1024:.1f} MB). "
                   f"Maximum allowed is {MAX_FILE_SIZE_BYTES // 1024 // 1024} MB.",
        )
    # Non-empty check
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")


def parse_cif(content: bytes) -> Structure:
    """Parse raw CIF bytes → pymatgen Structure. Raises HTTPException on failure."""
    try:
        # Write to a temp file so CifParser can read it
        with tempfile.NamedTemporaryFile(suffix=".cif", delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        parser = CifParser(tmp_path)
        structures = parser.parse_structures(primitive=False)

        if not structures:
            raise ValueError("CifParser returned no structures.")

        return structures[0]

    except (ValueError, KeyError, IndexError) as exc:
        logger.warning("CIF parse failed: %s", exc)
        raise HTTPException(
            status_code=422,
            detail=f"Could not parse CIF file: {str(exc)}. "
                   "Please ensure the file is a valid crystallographic information file.",
        ) from exc
    except Exception as exc:
        logger.error("Unexpected CIF parse error: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=422,
            detail="Unexpected error while parsing the CIF file. "
                   "Please check that it is a valid .cif structure.",
        ) from exc
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/", summary="Health check")
async def root():
    return {"status": "ok", "service": "T₂ Calculator API", "version": "1.0.0"}


@app.get("/health", summary="Health check")
async def health():
    return {"status": "healthy"}


@app.post(
    "/compute",
    response_model=ComputeResponse,
    summary="Upload a CIF file and compute T₂",
    description=(
        "Accepts a .cif crystal structure file. "
        "Parses lattice parameters and atomic sites using pymatgen, "
        "then calls compute_T2() to return the spin coherence time."
    ),
)
async def compute(
    file: UploadFile = File(..., description="CIF structure file"),
    dimensionality: str = "3D",   # "3D" or "2D" — sent by the frontend selector
):
    # ── Read & validate ───────────────────────────────────────────────────────
    content = await file.read()
    validate_upload(file, content)

    logger.info("Received file: %s (%d bytes)", file.filename, len(content))

    # ── Parse structure ───────────────────────────────────────────────────────
    structure = parse_cif(content)

    # ── Symmetry analysis ─────────────────────────────────────────────────────
    try:
        analyzer  = SpacegroupAnalyzer(structure)
        sym_data  = analyzer.get_symmetry_dataset()
        crystal_system  = analyzer.get_crystal_system()
        space_group     = analyzer.get_space_group_symbol()
        space_group_num = analyzer.get_space_group_number()
    except Exception as exc:
        logger.warning("Symmetry analysis failed (non-fatal): %s", exc)
        crystal_system  = "unknown"
        space_group     = "unknown"
        space_group_num = 0

    # ── Lattice parameters ────────────────────────────────────────────────────
    lattice = structure.lattice
    a, b, c             = lattice.abc
    alpha, beta, gamma  = lattice.angles
    volume              = lattice.volume

    # ── Density ───────────────────────────────────────────────────────────────
    try:
        density = structure.density
    except Exception:
        density = 0.0

    # ── Compute T₂ ────────────────────────────────────────────────────────────
    dim = dimensionality.strip().upper()
    if dim == "3D":
        # ── Placeholder: replace with your 2D function when ready ──────────
        # T2_value = Compute_T2_2D(structure)
        T2_value = Compute_T2_3D(structure)   # falls back to 3D model for now
    else:
        T2_value = Compute_T2_2D(structure)

    # ── Build response ────────────────────────────────────────────────────────
    response = ComputeResponse(
        chemical_formula    = structure.composition.formula,
        reduced_formula     = structure.composition.reduced_formula,
        num_atoms           = len(structure),
        num_sites           = structure.num_sites,
        lattice_parameters  = LatticeParameters(
            a=round(a, 6),
            b=round(b, 6),
            c=round(c, 6),
            alpha=round(alpha, 6),
            beta=round(beta, 6),
            gamma=round(gamma, 6),
            volume=round(volume, 6),
        ),
        crystal_system      = crystal_system,
        space_group         = space_group,
        space_group_number  = space_group_num,
        density             = round(density, 4),
        T2                  = T2_value,
        T2_unit             = "ms",
    )

    logger.info(
        "Result: formula=%s, atoms=%d, T2=%s",
        response.chemical_formula,
        response.num_atoms,
        T2_value,
    )

    return response



# ── Heterostructure endpoint ──────────────────────────────────────────────────
@app.post(
    "/compute_heterostructure",
    summary="Upload a 2D and a 3D CIF file and compute heterostructure T₂",
    description=(
        "Accepts two .cif files: one for the 2D monolayer (file_2d) and one for the 3D "
        "substrate (file_3d). Calls Compute_T2_Heterostructure() and returns the result."
    ),
)
async def compute_heterostructure(
    file_2d: UploadFile = File(..., description="2D monolayer CIF structure file"),
    file_3d: UploadFile = File(..., description="3D substrate CIF structure file"),
):
    # ── Read & validate both files ────────────────────────────────────────────
    content_2d = await file_2d.read()
    content_3d = await file_3d.read()
    validate_upload(file_2d, content_2d)
    validate_upload(file_3d, content_3d)

    logger.info(
        "Heterostructure: 2D=%s (%d bytes), 3D=%s (%d bytes)",
        file_2d.filename, len(content_2d), file_3d.filename, len(content_3d),
    )

    # ── Parse both structures ─────────────────────────────────────────────────
    structure_2d = parse_cif(content_2d)
    structure_3d = parse_cif(content_3d)

    # ── Symmetry analysis for the 2D layer (reported in response) ─────────────
    try:
        analyzer       = SpacegroupAnalyzer(structure_2d)
        crystal_system = analyzer.get_crystal_system()
        space_group    = analyzer.get_space_group_symbol()
        space_group_num = analyzer.get_space_group_number()
    except Exception as exc:
        logger.warning("Symmetry analysis failed (non-fatal): %s", exc)
        crystal_system  = "unknown"
        space_group     = "unknown"
        space_group_num = 0

    lattice = structure_2d.lattice
    a, b, c            = lattice.abc
    alpha, beta, gamma = lattice.angles
    volume             = lattice.volume
    try:
        density = structure_2d.density
    except Exception:
        density = 0.0

    # ── Compute heterostructure T₂ ────────────────────────────────────────────
    # ─────────────────────────────────────────────────────────────────────────
    # TODO: replace the line below with your own function, e.g.:
    #   T2_value = Compute_T2_Heterostructure(structure_2d, structure_3d)
    # The function receives both parsed pymatgen Structure objects and should
    # return a T₂ value in milliseconds (float).
    # ─────────────────────────────────────────────────────────────────────────
    T2_value = Compute_T2_Heterostructure(structure_2d, structure_3d)   # placeholder — replace when ready

    response = ComputeResponse(
        chemical_formula   = structure_2d.composition.formula,
        reduced_formula    = structure_2d.composition.reduced_formula,
        num_atoms          = len(structure_2d),
        num_sites          = structure_2d.num_sites,
        lattice_parameters = LatticeParameters(
            a=round(a, 6), b=round(b, 6), c=round(c, 6),
            alpha=round(alpha, 6), beta=round(beta, 6), gamma=round(gamma, 6),
            volume=round(volume, 6),
        ),
        crystal_system     = crystal_system,
        space_group        = space_group,
        space_group_number = space_group_num,
        density            = round(density, 4),
        T2                 = T2_value,
        T2_unit            = "ms",
    )

    logger.info(
        "Heterostructure result: 2D=%s, 3D=%s, T2=%s ms",
        structure_2d.composition.reduced_formula,
        structure_3d.composition.reduced_formula,
        T2_value,
    )
    return response


# ── Error handlers ────────────────────────────────────────────────────────────
@app.exception_handler(Exception)
async def generic_exception_handler(request, exc):
    logger.error("Unhandled exception: %s", exc, exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": "An internal server error occurred. Please try again."},
    )
