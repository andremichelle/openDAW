---
title: Validation
group: Guide
order: 7
---

# Validation

Every write is checked against the project schema before it lands, so a script cannot produce a broken project.

## Clamped

A number outside its documented range is clamped silently:

```ts
synth.volume = 20        // stored as 6
synth.instrument.cutoff = 5  // stored as 20
```

## Throws

| Situation                                   | Error                                             |
|---------------------------------------------|---------------------------------------------------|
| wrong type (`cutoff = "high"`)              | `cutoff: expected a number, got string`           |
| `NaN`                                       | `cutoff: NaN is not a valid value`                |
| unknown enumeration (`mode: 7` on Arpeggio) | `mode: 7 is not one of 0, 1, 2`                   |
| `+Infinity` on a gain                       | `volume: +Infinity is not a valid gain`           |
| overlapping regions                         | `Region [0, 3840] overlaps existing region ...`   |
| removing the output unit                    | `The output unit cannot be removed`               |
| `getProject()` without an open project      | throws, check `hasProject()` first                |
| `openInStudio()` after the studio changed   | refused with a toast, nothing applied             |

An uncaught error stops the script and shows in the editor. Nothing is applied to the studio until
`openInStudio()` succeeds, so a failing edit script leaves the open project untouched.
