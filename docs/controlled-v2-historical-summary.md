# Controlled V2 — historical measurement summary

This document transcribes author-reported August 2026 results from the technical article's archived draft. It is **not a newly executed benchmark or the original exporter JSON**. The raw historical run-level output is not currently available here. Please reproduce using the dedicated benchmark database described in [the evidence workflow](portfolio-evidence.md).

- Article: https://www.linkedin.com/pulse/planning-people-across-projects-calendar-problem-danylo-zubrii-8jnnf/
- Measured API commit: `1b9db00`; evidence contract: `ab46392`.
- Synthetic fixture: 281 hours, 13 staff, six weeks starting 2026-08-17.
- Five comparison requests, identical scenario signatures; median optimizer time 1.053 s; HTTP median 5.060 s, range 4.050–8.494 s.
- Search: 608 order states, 2,652 placement states, 11 retained candidates; state limit not reached.

## N−1 full-review results

| Profile | Average coverage | Worst coverage | Fully recoverable |
|---|---:|---:|---:|
| Balanced | 95.18% | 85.56% | 0/13 |
| Resilience First | 95.64% | 85.56% | 4/13 |

The worst case did not improve. The benchmark is designed to exhibit trade-offs, not to estimate production performance or prove global optimality. Five repetitions support a narrow repeatability check, not a robust latency distribution. A separate production observation must not be compared as the same dataset.
