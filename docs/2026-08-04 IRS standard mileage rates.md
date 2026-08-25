# IRS standard mileage rates: point-in-time snapshot

- **Source URL:** https://www.irs.gov/tax-professionals/standard-mileage-rates
- **Accessed:** 2026-08-04
- **Purpose:** seed data for the app's master `mileage_rates` table
  (`app/data/mileage-rates.ts`). The live page is mutable; this snapshot is
  the record of what the table was seeded from.

> If you use your car for business, charity, medical or moving purposes, you
> may be able to take a deduction based on the mileage used for that purpose.

## 2026 mileage rates (July 1 – Dec. 31)

The standard mileage rates for 2026 are:

- Self-employed and business: 76 cents/mile
- Charities: 14 cents/mile
- Medical: 23.5 cents/mile
- Moving (military only): 23.5 cents/mile

## Mileage rates for all years (cents/mile)

| Period                | Business | Charity | Medical or military moving | Source                   |
| --------------------- | -------- | ------- | -------------------------- | ------------------------ |
| 2026 (Jul 1 – Dec 31) | 76       | 14      | 23.5                       | IR-2026-29               |
| 2026 (Jan 1 – Jun 30) | 72.5     | 14      | 20.5                       | IR-2025-128              |
| 2025                  | 70       | 14      | 21                         | IR-2024-312              |
| 2024                  | 67       | 14      | 21                         | IR-2023-239              |
| 2023                  | 65.5     | 14      | 22                         | IR-2022-234              |
| 7/1/2022 – 12/31/2022 | 62.5     | 14      | 22                         | IR-2022-124              |
| 1/1/2022 – 6/30/2022  | 58.5     | 14      | 18                         | IR-2021-251              |
| 2021                  | 56       | 14      | 16                         | IR-2020-279              |
| 2020                  | 57.5     | 14      | 17                         | IR-2019-215              |
| 2019                  | 58       | 14      | 20                         | IR-2018-251              |
| 2018 (TCJA)           | 54.5     | 14      | 18                         | IR-2017-204, IR-2018-127 |
| 2017                  | 53.5     | 14      | 17                         | IR-2016-169              |
| 2016                  | 54       | 14      | 19                         | IR-2015-137              |
| 2015                  | 57.5     | 14      | 23                         | IR-2014-114              |
| 2014                  | 56       | 14      | 23.5                       | IR-2013-95               |
| 2013                  | 56.5     | 14      | 24                         | IR-2012-95               |
| 2012                  | 55.5     | 14      | 23                         | IRB-2012-02              |
| 7/1/2011 – 12/31/2011 | 55.5     | 14      | 23.5                       | IR-2011-69               |
| 1/1/2011 – 6/30/2011  | 51       | 14      | 19                         | IR-2010-119              |

Notes from the page: the 2018 rate is split across two announcements (TCJA
changed moving/medical rules); moving is deductible for members of the Armed
Forces and the Intelligence Community only. Dates before 2011 are not listed
on the page; no rate for earlier periods.
