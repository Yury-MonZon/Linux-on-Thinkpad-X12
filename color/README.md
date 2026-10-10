# Display color profile

`N123NCA_GS1.icm` is a factory-style ICC profile with a real vcgt calibration
table for the X12's InfoVision **N123NCA_GS1** panel (made with X-Rite
i1Profiler, measured 2021-03-29, about 385 cd/m2, white point D50-adapted).

## Source and credit

Measured and published by NotebookCheck as part of their X12 Detachable Gen 1
review. Mirrored here with credit so it does not disappear if that link goes
away. All rights to the measurement remain with the original publisher.

- Review: https://www.notebookcheck.net/Lenovo-ThinkPad-X12-Detachable-Gen-1-Review-Laptop-tablet-hybrid-with-LTE-Tiger-Lake-UP4.532888.0.html
- File: https://www.notebookcheck.net/uploads/tx_nbc2/N123NCA_GS1.icm

The profile embeds a `Copyright X-Rite, Inc.` string, which is just the
profiling software's marker, not a restriction added by this repo.

## Install

See [../docs/09-extras.md](../docs/09-extras.md) (display color profile), or run
[../install/install-icc-profile.sh](../install/install-icc-profile.sh) on the
X12 with this file as the argument.
