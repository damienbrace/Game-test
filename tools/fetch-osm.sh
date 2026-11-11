#!/usr/bin/env bash
# Downloads the raw OpenStreetMap extract for the play area from Overpass.
#   tools/fetch-osm.sh <output.json>
# Tries several public Overpass endpoints in turn. Keep the raw file OUT of
# the repo; only the processed data/bunbury.json is committed.
set -euo pipefail
out="${1:?usage: tools/fetch-osm.sh <output.json>}"
query="$(dirname "$0")/bunbury.overpassql"
for ep in https://overpass-api.de/api/interpreter \
          https://overpass.kumi.systems/api/interpreter \
          https://overpass.private.coffee/api/interpreter; do
  echo "trying $ep" >&2
  if curl -sS -f -m 300 --data-urlencode "data@${query}" -o "$out" "$ep" \
     && python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$out" 2>/dev/null; then
    echo "saved $out" >&2
    exit 0
  fi
done
echo "all Overpass endpoints failed" >&2
exit 1
