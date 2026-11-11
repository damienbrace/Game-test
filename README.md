# Coastline Cruiser: Bunbury

An original open-world driving game, phase 1: free-drive a low-poly car around
the real streets of Bunbury, Western Australia (CBD, the peninsula, Koombana
Bay, Leschenault Inlet, out to South and East Bunbury), built from
OpenStreetMap data with three.js. No missions or traffic yet.

## Run

It is a plain static site (ES modules, no build step, three.js vendored in
`vendor/`). Serve the repo root with any static server and open it:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

Opening `index.html` straight from disk (`file://`) will not work because the
map data is fetched. Add `?debug` to the URL for an FPS / draw-call overlay.

## Controls

| Action | Keyboard | Gamepad (standard mapping) | Touch |
| --- | --- | --- | --- |
| Steer | A / D or ← / → | Left stick X (analog, 15% deadzone), d-pad | Drag the thumb pad (bottom left) |
| Accelerate | W or ↑ | Right trigger (analog) | GAS |
| Brake / reverse | S or ↓ | Left trigger (analog) | BRAKE |
| Handbrake | Space | A / Cross | HAND BRAKE |
| Reset car to road | R | B / Circle | RESET (top right) |
| Switch camera | C | Y / Triangle | CAM (top right) |
| Sound on / off | M | – | SOUND (top right) |

All input methods work at the same time. Touch controls appear only on touch
devices; landscape is recommended on phones. Driving into the sea or inlet
resets the car to the last dry spot; grass, scrub and sand are drivable but slow.

## Files

- `index.html`, `style.css` – page, HUD and touch controls
- `src/main.js` – renderer, scene, game loop (fixed 120 Hz physics step)
- `src/world.js` – builds tiles of merged geometry from the map file, plus the
  collision grid, road lookup, surface raster and minimap image
- `src/buildings.js` – building archetypes (houses, main-street shops with
  verandahs, sheds, …), hipped/gable/flat roofs and the generated facade atlas
- `src/props.js` – street-level detail: tree shapes (eucalypt, peppermint,
  Norfolk Island pine, palm, broadleaf), street lights, traffic signals,
  painted crossings, bus stops, benches and other furniture, fences / walls,
  power lines, playground equipment, car-park bay lines; merged into the
  per-tile object meshes
- `src/car.js` – car model and arcade handling, building/tree collision
- `src/camera.js` – chase and high cameras
- `src/input.js` – keyboard, gamepad and touch input
- `src/hud.js` – speed, street name, minimap
- `src/audio.js` – procedural Web Audio sound (engine, tyres, impacts,
  splash); starts on the first key / touch / click, mute remembered locally.
  Tuning constants are in `TUNE` at the top of the file
- `data/bunbury.json` – preprocessed map data (generated, see below)
- `tools/` – map data pipeline
- `vendor/three/` – three.js r170 module build (MIT licence)

## Regenerating the map data

```sh
tools/fetch-osm.sh /tmp/bunbury-raw.json /tmp/bunbury-points.json   # Overpass (~6 MB + 0.25 MB)
node tools/build-map.mjs /tmp/bunbury-raw.json data/bunbury.json /tmp/bunbury-points.json
```

The queries are in `tools/bunbury.overpassql` (roads, buildings, land use,
water) and `tools/bunbury-points.overpassql` (street detail: trees, lamps,
signals, crossings, bus stops, furniture, barriers, power lines, playground
equipment), both for bbox lat −33.365…−33.300, lon 115.612…115.690. `build-map.mjs` (Node 18+, no dependencies) projects
everything to local metres around the CBD (−33.3267, 115.6370), rounds to
0.1 m, keeps only the tags the game uses, and:

- turns the coastline (a line in OSM, land on its left) into sea polygons by
  clipping it to a box and closing it along the box edge on the sea side;
- classifies each stretch of coastline as beach (mapped `natural=beach/sand`
  nearby, or open ocean: rays cast seaward reach 2.5 km without meeting
  land), sheltered shore, or breakwater / harbour wall (land under 70 m
  thick); only beaches get sand, the others a rock edge in the game;
- assembles multipolygon relations (e.g. Leschenault Estuary) into rings;
- estimates road widths from `width` / `lanes` / road class, keeps `lanes`
  for lane markings, and marks junction vertices (the game builds junction
  plates, give-way lines and marking gaps from them);
- joins `junction=roundabout` ways into rings and stores each as a centre and
  radius profile, drawn as a smooth annulus with a round island;
- keeps rivers (`waterway=river/canal` centrelines), railway bridges,
  harbour basins (for quay edges) and the orientation / size of sports
  pitches (oval, wicket, court and field markings);
- picks building heights from `height` / `building:levels`, otherwise from
  the building type;
- drops the few buildings that a road centreline passes through, so roads
  are never blocked;
- scatters trees in woods, scrub and parks, away from roads and buildings,
  and picks each one's shape (Norfolk Island pines and palms near the coast,
  eucalypts and peppermints inland; deterministic, OSM has no species here);
- places street props: mapped trees, signals (a pole per approach), painted
  crossings, bus stops, furniture, fences / walls, power towers and poles,
  playground kit; street lights where mapped, otherwise along lit, arterial
  and residential roads at the kerb; plus procedural playground kit in mapped
  playgrounds without equipment. Every prop is checked to stand clear of all
  carriageways, junctions, roundabouts, buildings and water;
- finds the spawn point on Victoria Street.

Do not commit the raw download; only `data/bunbury.json` is used at runtime
(the game never contacts Overpass).

## Data credit and licence

Map data © OpenStreetMap contributors, available under the Open Database
Licence (ODbL) 1.0 – https://www.openstreetmap.org/copyright.
`data/bunbury.json` is a derived database and is likewise ODbL. The credit is
shown in-game at all times.

three.js is © three.js authors, MIT licence (`vendor/three/LICENSE`).
