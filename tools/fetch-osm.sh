#!/usr/bin/env bash
# Downloads the raw OpenStreetMap extracts for the play area from Overpass.
#   tools/fetch-osm.sh <output.json> [points-output.json]
# The first file (tools/bunbury.overpassql) holds roads, buildings, land use,
# water and coast. The optional second one (tools/bunbury-points.overpassql)
# holds street detail: trees, street lamps, traffic signals, crossings, bus
# stops, benches and other furniture, barriers, power lines, playground kit.
# Tries several public Overpass endpoints in turn. Keep the raw files OUT of
# the repo; only the processed data/bunbury.json is committed.
set -euo pipefail
out="${1:?usage: tools/fetch-osm.sh <output.json> [points-output.json]}"
points="${2:-}"
dir="$(dirname "$0")"

fetch() { # <query file> <output>
  for ep in https://overpass.kumi.systems/api/interpreter \
            https://overpass-api.de/api/interpreter \
            https://overpass.private.coffee/api/interpreter; do
    echo "trying $ep" >&2
    if curl -sS -f -m 300 --data-urlencode "data@$1" -o "$2" "$ep" \
       && python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$2" 2>/dev/null; then
      echo "saved $2" >&2
      return 0
    fi
  done
  echo "all Overpass endpoints failed for $1" >&2
  return 1
}

fetch "$dir/bunbury.overpassql" "$out"
if [ -n "$points" ]; then fetch "$dir/bunbury-points.overpassql" "$points"; fi
