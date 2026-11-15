"""Build public DC fast-charger catalog and cached OSRM routes."""
import argparse
import csv
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

DATA = Path('site/data')
ROUTER = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/'
CORRIDORS = [
    ('Atlanta, GA','Miami, FL'), ('Los Angeles, CA','Las Vegas, NV'),
    ('New York, NY','Boston, MA'), ('Dallas, TX','Houston, TX'),
    ('Seattle, WA','Portland, OR'),
]


def get_route(start, end):
    coordinates = ';'.join(','.join(map(str,p)) for p in (start,end))
    request = Request(ROUTER + coordinates + '?overview=simplified&geometries=geojson&steps=false',
                      headers={'User-Agent':'ChargePilot portfolio'})
    with urlopen(request,timeout=20) as response:
        route=json.load(response)['routes'][0]
    return {k:route[k] for k in ('distance','duration','geometry')}


def stations(path):
    mapping={'TESLA':'NACS','J3271':'NACS','J3400':'NACS','J1772COMBO':'CCS','CHADEMO':'CHAdeMO'}
    rows=[]
    with path.open(encoding='utf-8-sig',newline='') as source:
        for row in csv.DictReader(source):
            connectors=sorted({mapping[plug] for plug in row['EV Connector Types'].split() if plug in mapping})
            lat,lon=row['Latitude'],row['Longitude']
            if not connectors or not lat or not lon or row['Country']!='US' or row['Status Code']!='E' or row['Access Code']!='public':
                continue
            if (row['Restricted Access'].lower() in {'true','yes','1'} or int(row['EV DC Fast Count'] or 0)<1
                    or re.search(r'\b(?:private|employees only|fleet only|members only)\b', ' '.join((row['Station Name'],row['Access Days Time'])),re.I)):
                continue
            rows.append([row['ID'],row['Station Name'],round(float(lat),5),round(float(lon),5),
                         row['EV Network'] or 'Unspecified',connectors,int(row['EV DC Fast Count']),
                         row['Street Address'],row['City'],row['State'],row['EV Pricing'],row['Access Days Time']])
    if len(rows)<5000:
        raise ValueError('Expected coverage of thousands of public U.S. DC sites')
    return rows


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv',type=Path)
    parser.add_argument('--seed-route',type=Path,help='Cached Atlanta-to-Miami OSRM response')
    parser.add_argument('--stations-only',action='store_true')
    args=parser.parse_args()
    records=stations(args.csv)
    (DATA/'stations.json').write_text(json.dumps({'downloaded':datetime.now(timezone.utc).isoformat(),'rows':records},separators=(',',':'))+'\n')
    print(len(records),'DC sites')
    if not args.stations_only:
        cities=json.loads((DATA/'cities.json').read_text())
        cache={}
        for i,(start,end) in enumerate(CORRIDORS):
            if i==0 and args.seed_route:
                route=json.loads(args.seed_route.read_text())['routes'][0]
                route={k:route[k] for k in ('distance','duration','geometry')}
            else:
                try: route=get_route(cities[start],cities[end])
                except (OSError,ValueError,KeyError,IndexError) as error:
                    print('Route unavailable:',start,end,type(error).__name__)
                    continue
            cache[start+'|'+end]=route
        if not cache:
            raise ValueError('No routes acquired')
        (DATA/'routes.json').write_text(json.dumps(cache,separators=(',',':'))+'\n')
