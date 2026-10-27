# Efficiency playbook

How to review this Daikin Altherma 3 H HT for lower electricity use, and the
reasoning behind the rules in `src/lib/efficiency.js`. Everything here is
read-only advice. Settings change only with the owner's explicit approval,
one at a time, with a measurement period after each change.

## The installation

| Item | Value | Status |
| --- | --- | --- |
| Indoor unit | `ETVX16S23D9W` | Nameplate |
| Outdoor unit | `EPRA14DW1`, 14 kW, three phase | Nameplate |
| Heating and cooling | ETVX suggests a reversible unit | Confirm from payload (`operationMode` values) |
| Hot-water tank | S23 suggests an integrated 230 L tank | Confirm from payload or manual |
| Backup heater | D9W suggests 9 kW, three phase | Confirm on the indoor unit |
| Heat emitters | Underfloor heating throughout | Owner |
| Tariff | Single flat rate | Owner |
| Solar | None | Owner |
| Walls | 36 cm BCA (autoclaved aerated concrete) + 10 cm basalt wool | Owner; U ≈ 0.16 W/m²K estimated |
| Roof | 25 cm basalt wool | Owner; U ≈ 0.14–0.18 W/m²K estimated, depending on rafter bridging |
| Windows | Double glazing, 6 mm panes, low-e with argon fill, wood frames, about 6 years old (c. 2020) | Owner; Ug ≈ 1.1 and Uw ≈ 1.2–1.3 W/m²K estimated |
| Heated area | About 160 m² over two floors | Owner; ground floor over the basement assumed about 80 m² |
| Below the heated floor | Unheated basement without floor heating, 5 cm insulation under the heated slab | Owner; floor U ≈ 0.5–0.6 W/m²K estimated |
| Ventilation | Opening windows only | Owner |
| Room thermostats | A floor thermostat in every room | Owner; setpoints and whether they drive manifold actuators to be confirmed |

The U-values are estimates from typical conductivities (BCA about
0.11 W/mK, basalt wool about 0.037 W/mK) and surface resistances. They are
well inside Romania's nZEB requirements, so the profile uses the
"new build, well insulated" category, and the water-temperature check is
about 3 °C stricter at the cold end.

Two consequences shape this review:

- **Very cool water should be enough.** With envelope losses this low,
  underfloor heating can typically run on about 25–30 °C for most of the
  winter. Every degree of curve that can come off is worth having.
- **The 14 kW unit is probably oversized for the load.** On mild days its
  minimum output can exceed the house's heat loss, so it cycles on and off.
  Cycling costs efficiency and wears the compressor, and room thermostats
  closing loops make it worse. A low curve, open loops and no setbacks keep
  it running long and slow. Check compressor running hours against starts
  on review day: long runs per start are good, many short runs are not.

Room temperatures the owner keeps: living room and kitchen 20–21 °C,
bedrooms about 21 °C, two bathrooms 19 °C, office 19 °C, a small bedroom
17 °C and the dressing room 15 °C. The water must suit the 21 °C rooms, so
the cooler rooms' thermostats will hold their loops shut much of the time.
Balancing the manifold so those loops get less flow, rather than switching
on and off, is likely the first practical change (the `room-balance`
rule). Room areas go into **System → Your home → Rooms**.

With walls around 0.16 W/m²K, the windows (around 1.1–1.4 W/m²K even if
modern, which these are) and the floor over the unheated basement are probably where most
of the remaining heat goes.

The floor is the clearest building improvement. Floor heating keeps the
screed at about 28 °C, and only 5 cm of insulation separates it from a
basement at roughly 10–12 °C. That is about 9–10 W per m² of heated floor
lost downwards. Only the ground floor sits over the basement (the upper
floor's downward heat goes into heated rooms), so with about 80 m² that is
roughly 0.75 kW continuously through the heating season, around 900 kWh of
electricity a year at a seasonal COP of 4. Insulating the basement ceiling from below
with 10 cm or more of mineral wool or EPS would cut that by about two
thirds; it is usually simple to install because the ceiling is
accessible. These are estimates from typical conductivities; the measured
kWh per degree-day before and after is the real test.

Ventilation is by opening windows only. With an envelope this tight, fresh
air is likely a third or more of the heat loss. Short, wide-open airing
(5–10 minutes, a few times a day) swaps the air without cooling the
thermal mass; tilted windows left open for hours keep the floor loop of
that room heating the outside. Watch indoor humidity: a tight house aired
too little risks condensation and mould. Heat-recovery ventilation is the
long-term upgrade if comfort or humidity becomes a problem.

**Owner constraint (2026-10-27):** insulating the basement ceiling and
changing how rooms are ventilated are not possible for now. The review
focuses on what can change today: heat-pump settings (curve, offset,
setbacks, hot water) and manifold balancing. Those two suggestions can be
set aside in the dashboard ("Not now") and brought back later.

The windows are recent and replacing them would not pay back; at most,
check seals and adjust the hinges if any draught is felt.

Still unknown: the exact ground-floor area over the basement (enter it in
**Your home**).

On a flat tariff with no solar, **when** electricity is used costs nothing
extra. The only lever is **how much** is used, which means raising the
coefficient of performance (COP): heat delivered per kWh of electricity.

## What drives consumption, in order of typical impact

1. **Leaving-water temperature.** The compressor works harder the hotter the
   water it has to make. Manufacturer COP tables for air-to-water units
   typically lose about 2–3 % of COP for every 1 °C of extra flow
   temperature (the app uses 2.5 %). Underfloor heating can usually run on
   about 30 °C or less at +5 °C outside and about 35 °C at design
   temperature. The weather-dependent curve sets this; the ONECTA water
   offset shifts the whole curve.
2. **Room target.** Each 1 °C of indoor temperature commonly costs 5–10 % of
   heating energy depending on the house; the app uses a conservative 6 %.
3. **Steady operation.** A slab floor stores heat and reacts over hours.
   Deep night setbacks force a hard, hot morning recovery, sometimes with the
   backup heater, and usually save nothing. Keep setbacks to about 1 °C or
   run a constant target.

   Every room in this house has its own floor thermostat. If they close loops on the
   manifold, flow drops, the unit needs hotter water for the loops still
   open, and it cycles more. The usual fix is to set them 1–2 °C above the
   wanted temperature so they act only as upper limits, keep the largest
   rooms always open, and let the weather curve regulate. With a
   thermostat in every room, all loops can close at once; the unit then
   needs a guaranteed minimum flow or it short-cycles. Check whether the
   manifold has a bypass or buffer that guarantees minimum flow.
4. **The backup heater.** It turns 1 kWh of electricity into 1 kWh of heat,
   against 3–4 kWh from the compressor. It should only run below the balance
   temperature, during defrost support, or for disinfection if configured.
5. **Hot water.** Higher tank temperatures lower hot-water COP. 45–48 °C is
   usually enough for a household; weekly disinfection handles legionella.
   Heating the tank when outdoor air is warmest (early afternoon) gives a
   better COP than at night.
6. **Season.** Space heating should stop once the weekly outdoor mean is
   above about 16 °C. `auto` mode can switch to cooling on mild sunny days
   and back, which wastes energy on underfloor heating.

## What can be changed where

**Through ONECTA and this dashboard** (only if the unit advertises it as
settable): room target, leaving-water offset, operation mode, power, tank
target, powerful (boost) mode, heating and hot-water schedules.

**Only on the indoor unit's installer menu** (photograph the screens for the
review; field-setting codes must be checked against the installer reference
guide for `ETVX16S23D9W`, not guessed):

- weather-dependent curve: leaving-water temperature at the low and high outdoor points;
- space-heating OFF temperature;
- backup heater: enabled steps, balance or bivalent temperature, use for hot water;
- legionella disinfection: day, time, temperature, frequency;
- control method: leaving water, external room thermostat, or the unit's own room thermostat;
- water pump mode: continuous, sampling or on demand;
- hot water: reheat mode, hysteresis, maximum temperature;
- room thermostats: which rooms, their setpoints, and whether they drive
  actuators on the floor manifold;
- manifold: bypass valve, buffer tank or separate circulation pump.

## Measuring

- **kWh per heating degree-day** (`monthlyStats` in `src/lib/efficiency.js`).
  Heating electricity from ONECTA's consumption data, divided by degree-days
  at a 15.5 °C base from Open-Meteo for the rounded home location. This makes
  a mild month comparable with a cold one. Months count once at least 90 % of
  their days have weather data and they have 30 or more degree-days.
- **Journal** (`src/lib/journal.js`, stored encrypted as `journal.enc.json`
  locally or `pdc-control:journal` in Redis): readings sampled whenever
  ONECTA is actually fetched (no extra quota), daily and monthly kWh merged
  from ONECTA's rolling arrays, weather, and a log of every setting changed
  through the dashboard.
- ONECTA's `m` array holds 24 months, so a baseline exists on day one.
- **Weather accuracy.** Open-Meteo receives the location rounded to 0.1°
  (about 8–11 km here), which is no coarser than its model grids. The
  house altitude from the profile is sent as `elevation`, so temperatures
  are corrected for the house rather than for the rounded point
  (about 0.65 °C per 100 m).
- **Sensor cross-check** (`sensorCheck` in `src/lib/efficiency.js`). About
  30 days of hourly Open-Meteo temperatures are kept and matched to the
  heat pump's outdoor readings at the same UTC hour. The median difference
  over at least 20 readings on 3 days is shown in the dashboard and by the
  audit script; beyond ±1.5 °C it becomes a finding. A consistent offset
  shifts absolute kWh per degree-day but not before/after comparisons. The
  unit's sensor itself reads high in sun and during defrost, so check its
  position before blaming the weather data.

The ONECTA array alignment assumed here (`w` = last week Monday to Sunday,
then this week; `m` = last year January to December, then this year) must be
checked against the real payload on the first review.

## Change protocol

1. Pick the single finding with the biggest estimated saving that the owner
   is comfortable trying.
2. Note the current kWh per degree-day and the date.
3. Make one change through the dashboard (it is logged) or, for installer
   settings, write it down with the old value.
4. Wait 5–7 days. Floors are slow; judge comfort after two days at the
   earliest.
5. Compare kWh per degree-day. Keep the change if comfort held and the figure
   fell; otherwise revert.

Water curve and offset changes go in steps of 1 °C. Room target changes go
in steps of 0.5 °C.

## Review-day procedure

1. Confirm the gateway appears: `GET /api/devices?refresh=true` returns a
   device.
2. Fill in **System → Your home** in the dashboard if it is still empty.
3. Run `node scripts/efficiency-audit.mjs` on the Mac. It makes one ONECTA
   request, writes a redacted payload to `data/audits/<date>.json`, and
   prints findings and the installer checklist.
4. Check the redacted file contains no IDs, serial numbers, MAC or IP
   addresses before sharing it with an agent.
5. Map the real management points, enum values, ranges and schedule format
   (AGENTS.md follow-up 2). Adjust rule patterns only from that payload.
6. Collect the installer-menu photos listed above.
7. Write the personalised recommendations below.

## Current setup

To be completed on review day from the redacted payload and installer-menu
photos.
