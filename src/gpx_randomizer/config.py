from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    snap_m: float = 5.0
    min_edge_m: float = 15.0
    max_connector_m: float = 2000.0
    target_len_tol: float = 0.03
    beam_width: int = 50
    branch_bias_default: float = 0.0
    hill_bias_default: float = 0.0
    sample_step_m: float = 75.0
    seed_default: int | None = None
