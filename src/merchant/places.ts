// Choosing a place within a country, on the Users list.

import { countryName } from './format'

export type PlaceChoice = [region: string | null, city: string | null]

/** A country's regions, each with its cities, then cities with no known region. */
export function placeOptions(
  country: string,
  places: { region: string | null; city: string | null }[],
  chosen: PlaceChoice,
): Array<{ value: string; label: string; group?: string }> {
  // The chosen place stays listed while the page that names it loads.
  const all = chosen[0] || chosen[1] ? [...places, { region: chosen[0], city: chosen[1] }] : places
  const sorted = (values: (string | null)[]) =>
    [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) =>
      a.localeCompare(b),
    )
  const options: Array<{ value: string; label: string; group?: string }> = [
    { value: '', label: `All of ${countryName(country)}` },
  ]
  for (const region of sorted(all.map((place) => place.region))) {
    options.push({
      value: JSON.stringify([region, null]),
      label: `All of ${region}`,
      group: region,
    })
    for (const city of sorted(all.filter((place) => place.region === region).map((p) => p.city)))
      options.push({ value: JSON.stringify([region, city]), label: city, group: region })
  }
  for (const city of sorted(all.filter((place) => !place.region).map((place) => place.city)))
    options.push({ value: JSON.stringify([null, city]), label: city, group: 'Region not known' })
  return options
}
