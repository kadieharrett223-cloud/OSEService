// Mechanical conversion of the public Census 2025 ZCTA Gazetteer, not customer data.
// Source: https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip
import { readFileSync, writeFileSync } from 'node:fs';
const text = readFileSync(process.argv[2], 'utf8');
const coordinates = {};
for (const line of text.trim().split(/\r?\n/).slice(1)) {
  const cells = line.split('|').map(s => s.trim());
  const lat = Number(cells[6]), lon = Number(cells[7]);
  if (!/^\d{5}$/.test(cells[0]) || !Number.isFinite(lat) || !Number.isFinite(lon)) throw Error('Invalid Census row');
  coordinates[cells[0]] = [lat, lon];
}
if (Object.keys(coordinates).length < 30000) throw Error('Incomplete Census file');
writeFileSync(new URL('../src/lib/shipping/zcta-2025.json', import.meta.url), JSON.stringify(coordinates));
console.log(`${Object.keys(coordinates).length} public ZCTA points converted`);
