# Time model v0 validation

Measured door-to-door from boarding terminal = waiting at terminal + ride (2021 onboard surveys, TfC routes only).

- **Hold-out** (calibrated on June, tested on July–August): 120 trips · actual time inside range 77% · mid-estimate error 20.0 min (mean abs) · average range width 60 min
- Baseline for comparison, schedule only (no calibration, no wait): mean abs error 25.6 min on the same hold-out trips
- In-sample (shipped factors, all trips): 590 trips · actual time inside range 79% · mid-estimate error 16.9 min (mean abs) · average range width 60 min

Limits: the TfC schedules were themselves built from these surveys, so this checks calibration and range width,
not route accuracy. 2015 central-Accra routes have no measured trips here and reuse the same factors.
Independent checks (Phase 1 field trips, rider reports) are still needed.
