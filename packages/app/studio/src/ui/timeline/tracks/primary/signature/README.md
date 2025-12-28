# Signature Track

The Signature Track is a primary timeline track for managing time signature changes.

## Data Model

### SignatureEventBox

Each signature event has:
- `index: int32` - Sorting order (0, 1, 2, ...)
- `relative-position: int32` - Number of bars this signature spans (positive integer)
- `nominator: int32` - Time signature numerator (e.g., 4 in 4/4)
- `denominator: int32` - Time signature denominator (e.g., 4 in 4/4)

The `relative-position` field defines how many bars this signature lasts. The absolute position is computed by accumulating the relative positions of all preceding events.
