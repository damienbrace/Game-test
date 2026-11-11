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
- `src/car.js` – car model and arcade handling, building/tree collision
- `src/camera.js` – chase and high cameras
- `src/input.js` – keyboard, gamepad and touch input
- `src/hud.js` – speed, street name, minimap
- `data/bunbury.json` – preprocessed map data (generated, see below)
- `tools/` – map data pipeline
- `vendor/three/` – three.js r170 module build (MIT licence)

## Regenerating the map data

```sh
tools/fetch-osm.sh /tmp/bunbury-raw.json            # Overpass download (~6 MB)
node tools/build-map.mjs /tmp/bunbury-raw.json data/bunbury.json
```

The query is in `tools/bunbury.overpassql` (bbox lat −33.365…−33.300,
lon 115.612…115.690). `build-map.mjs` (Node 18+, no dependencies) projects
everything to local metres around the CBD (−33.3267, 115.6370), rounds to
0.1 m, keeps only the tags the game uses, and:

- turns the coastline (a line in OSM, land on its left) into sea polygons by
  clipping it to a box and closing it along the box edge on the sea side;
- assembles multipolygon relations (e.g. Leschenault Estuary) into rings;
- estimates road widths from `width` / `lanes` / road class and marks
  junction vertices so road markings stop at intersections;
- picks building heights from `height` / `building:levels`, otherwise from
  the building type;
- drops the few buildings that a road centreline passes through, so roads
  are never blocked;
- scatters trees in woods, scrub and parks, away from roads and buildings;
- finds the spawn point on Victoria Street.

Do not commit the raw download; only `data/bunbury.json` is used at runtime
(the game never contacts Overpass).

## Data credit and licence

Map data © OpenStreetMap contributors, available under the Open Database
Licence (ODbL) 1.0 – https://www.openstreetmap.org/copyright.
`data/bunbury.json` is a derived database and is likewise ODbL. The credit is
shown in-game at all times.

three.js is © three.js authors, MIT licence (`vendor/three/LICENSE`).
