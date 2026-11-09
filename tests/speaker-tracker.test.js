const test = require('node:test');
const assert = require('node:assert/strict');

const { SpeakerTracker, cosine, average, normalize } = require('../src/core/speaker-tracker');

// Synthetic "voices": distinct directions in a small space, plus a little noise.
const voiceA = [1, 0.1, 0, 0];
const voiceB = [0, 1, 0.1, 0];
const voiceC = [0, 0, 1, 0.1];
const near = (vector, bump) => vector.map((value, i) => value + (i === 3 ? bump : 0.02));

test('cosine is 1 for equal direction, 0 for orthogonal, 0 for bad input', () => {
  assert.ok(Math.abs(cosine([1, 2], [2, 4]) - 1) < 1e-9);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0], [1, 0, 0]), 0);
  assert.equal(cosine([], []), 0);
});

test('average of clips is a unit vector near the clips', () => {
  const mean = average([voiceA, near(voiceA, 0.05), near(voiceA, -0.05)]);
  assert.ok(Math.abs(Math.hypot(...mean) - 1) < 1e-9);
  assert.ok(cosine(mean, voiceA) > 0.99);
});

test('the enrolled voice is labelled You, others are grouped as Other 1, Other 2', () => {
  const tracker = new SpeakerTracker({ voiceprint: voiceA, threshold: 0.5 });
  assert.equal(tracker.assign(near(voiceA, 0.03)).label, 'You');
  assert.equal(tracker.assign(voiceB).label, 'Other 1');
  assert.equal(tracker.assign(voiceC).label, 'Other 2');
  assert.equal(tracker.assign(near(voiceB, 0.04)).label, 'Other 1');
  assert.equal(tracker.otherCount, 2);
});

test('without a voiceprint every voice is an Other and the first is not You', () => {
  const tracker = new SpeakerTracker({ threshold: 0.5 });
  assert.equal(tracker.assign(voiceA).label, 'Other 1');
  assert.equal(tracker.assign(voiceA).label, 'Other 1');
  assert.equal(tracker.assign(voiceB).label, 'Other 2');
});

test('a stricter threshold splits a voice; custom labels are used', () => {
  const tracker = new SpeakerTracker({ voiceprint: voiceA, threshold: 0.9999, ownerLabel: 'Me', otherLabel: 'Guest' });
  const result = tracker.assign(near(voiceA, 0.2));
  assert.equal(result.label, 'Guest 1');
  assert.equal(result.owner, false);
});

test('normalize handles a zero vector without NaN', () => {
  assert.deepEqual(normalize([0, 0]), [0, 0]);
});
