# ChargePilot

**[Open ChargePilot](https://mykeil-tzul.github.io/chargepilot/)**

ChargePilot helps me answer the questions that come up before an EV road trip. How far can I go on my starting charge? Where could I stop? How much time or money could I save by picking a different station?

Start with the Tesla Model Y example from Atlanta to Miami. Set your battery reserve, compare time-first and cost-first stops, and use the Range Simulator to see how cold weather, higher speeds, or extra weight can change the estimate.

## What you can do

- **Trip Planner** uses road routing and a battery model to compare reachable charging stops. Each stop shows estimated arrival and departure battery, charging time, detour distance, and spending.
- **Charging Map** plots public DC fast chargers along the route. Filter by connector or network and click a station for the address and any price or hours notes in the source catalog.
- **Range Simulator** compares reference conditions, your settings, and a cold-weather scenario. The headline range preserves the reserve you entered.
- **My Garage** saves a custom vehicle profile in your browser. Built-in vehicle figures are editable illustrative assumptions. Actual usable battery and charging speed depend on the model year, trim, and conditions.
- **Cost Comparison** compares the trip’s estimated electricity and fuel costs, plus annual scenarios using your charging mix, fuel price, mileage, and fixed costs.
- **Ownership Dashboard** saves trip estimates and charging records in the browser. It calculates billed efficiency and cost per mile and exports your charging records as CSV.

## How the routing and charging model works

1. Fetch a driveable road route from the OSRM service at routing.openstreetmap.de. Five common demo routes are bundled so they can load without a routing request.
2. Project AFDC station coordinates onto the route, retain sites within roughly five miles, and filter for connector compatibility. The detour is inferred from the site’s distance off-route. It is not separately routed, so check interchange access before driving.
3. Estimate energy from usable capacity, speed, temperature, load, and the configured Wh/mi. The weather and weight multipliers are transparent assumptions. There is no live weather, terrain, traffic, wind or vehicle telemetry in the model.
4. Search forward over candidate stops and battery states. The optimizer estimates charging taper, energy required on each leg, detours, and a fixed stop overhead. It rejects itinerary legs below the selected reserve. The comparison uses modeled network power and prices, and the search discretizes battery states.
5. Apply the user’s fast-charge rate and illustrative network differences. The operator’s real price, plug availability, vehicle access, queue, and power can differ. Use the station operator’s app to confirm these details. ChargePilot does not connect to a Tesla account or control a vehicle.

## Run locally

```sh
python3 -m http.server 8000 --directory site
node --test tests/*.test.mjs
```

Open `http://localhost:8000`. Directory files contain a dated [AFDC public charger catalog snapshot](https://developer.nlr.gov/docs/transportation/alt-fuel-stations-v1/). To refresh it, download the U.S. public electric station CSV from AFDC and run `python3 scripts/build_data.py <csv> --stations-only`. Omit `--stations-only` to refresh the cached routes too. Station listings are not status telemetry. The app sends selected city-center coordinates to the routing provider for uncached routes. The garage and charging history stay in browser storage.

Automated tests cover battery math, charging taper, compatible connectors, unreachable routes, and the full Atlanta–Miami case. The real-route test recalculates every leg to check the reserve and compares the time and cost options. GitHub Actions runs the tests before publishing the static app.

## Data and photos

- Road routing and map data from [OSRM](https://project-osrm.org/) and [OpenStreetMap](https://www.openstreetmap.org/copyright). Tiles by [CARTO](https://carto.com/attributions). The map uses Leaflet.
- Tesla Model Y photo by [Vauxford](https://commons.wikimedia.org/wiki/File:2022_Tesla_Model_Y_Long_Range_AWD_Front.jpg), resized from the original under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- Charging site photo by [Connor Williams](https://commons.wikimedia.org/wiki/File:Tesla_charging_station.jpg), resized from the original under [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/).
- Vehicle film: [The New Model Y](https://www.youtube.com/watch?v=Jt7DqX2AlNo) from Tesla. The film is a visual reference. Trip and range estimates use the editable vehicle assumptions in the app.
