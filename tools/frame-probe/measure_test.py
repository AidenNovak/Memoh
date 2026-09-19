#!/usr/bin/env python3
"""Pure regression tests for frame-probe validity decisions."""

import importlib.util
from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('frame_probe_measure', HERE / 'measure.py')
MEASURE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MEASURE)


class ReadingValidityTests(unittest.TestCase):
    def test_non_reading_probe_does_not_require_reading_pairs(self):
        geometry = {'pairs_examined': 0, 'reading_frames': 0}
        self.assertIsNone(MEASURE.reading_invalid_reason(geometry, False))

    def test_missing_reading_pairs_is_structurally_invalid(self):
        geometry = {'pairs_examined': 19, 'reading_frames': 80}
        reason = MEASURE.reading_invalid_reason(geometry, True)
        self.assertIsNotNone(reason)
        self.assertIn('19 个带追加的帧对', reason)
        self.assertIn('A/C 两条判据没被行使', reason)

    def test_twenty_reading_pairs_is_enough_to_exercise_the_invariants(self):
        geometry = {'pairs_examined': 20, 'reading_frames': 80}
        self.assertIsNone(MEASURE.reading_invalid_reason(geometry, True))


if __name__ == '__main__':
    unittest.main()
