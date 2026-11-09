/**
 * Decides who is speaking from speaker embeddings. Pure maths: no audio, no
 * Electron, no disk. The embeddings come from scripts/voice_worker.py.
 *
 * - An enrolled voiceprint is the anchor: an utterance close enough to it is
 *   the owner ("You").
 * - Everyone else is grouped on the fly: an utterance joins the closest earlier
 *   voice if it is similar enough, otherwise it starts a new one
 *   ("Other 1", "Other 2", ...). Centroids are running means, so a voice gets
 *   steadier as it speaks more.
 *
 * Embeddings from very short utterances are unreliable, so those are not
 * assigned here; the caller keeps the previous label instead.
 */

function norm(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  return Math.sqrt(sum);
}

function normalize(vector) {
  const length = norm(vector) || 1;
  return Array.from(vector, (value) => value / length);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denominator = Math.sqrt(na) * Math.sqrt(nb);
  return denominator > 0 ? dot / denominator : 0;
}

/** Mean of several embeddings, re-normalised: the voiceprint from enrollment clips. */
function average(embeddings) {
  if (!embeddings.length) return [];
  const sum = new Array(embeddings[0].length).fill(0);
  for (const embedding of embeddings) {
    const unit = normalize(embedding);
    for (let i = 0; i < sum.length; i++) sum[i] += unit[i];
  }
  return normalize(sum);
}

class SpeakerTracker {
  /**
   * @param {object}   options
   * @param {number[]} [options.voiceprint]  enrolled embedding of the owner
   * @param {number}   [options.threshold]   cosine needed to count as the same voice
   * @param {string}   [options.ownerLabel]  label for the owner
   * @param {string}   [options.otherLabel]  prefix for everyone else
   */
  constructor({ voiceprint = null, threshold = 0.5, ownerLabel = 'You', otherLabel = 'Other' } = {}) {
    this.voiceprint = voiceprint && voiceprint.length ? normalize(voiceprint) : null;
    this.threshold = threshold;
    this.ownerLabel = ownerLabel;
    this.otherLabel = otherLabel;
    this.voices = []; // { sum: number[], count: number }
  }

  /**
   * @param {number[]} embedding
   * @returns {{ label: string, score: number, owner: boolean, voice: number|null }}
   *   score is the cosine to the voiceprint (owner) or to the matched voice.
   */
  assign(embedding) {
    const unit = normalize(embedding);

    if (this.voiceprint) {
      const score = cosine(unit, this.voiceprint);
      if (score >= this.threshold) {
        return { label: this.ownerLabel, score, owner: true, voice: null };
      }
    }

    let best = -1;
    let bestScore = -1;
    this.voices.forEach((voice, index) => {
      const score = cosine(unit, voice.sum);
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    });

    if (best >= 0 && bestScore >= this.threshold) {
      const voice = this.voices[best];
      for (let i = 0; i < unit.length; i++) voice.sum[i] += unit[i];
      voice.count++;
      return { label: `${this.otherLabel} ${best + 1}`, score: bestScore, owner: false, voice: best + 1 };
    }

    this.voices.push({ sum: unit.slice(), count: 1 });
    return { label: `${this.otherLabel} ${this.voices.length}`, score: Math.max(bestScore, 0), owner: false, voice: this.voices.length };
  }

  /** How many distinct other voices have been heard. */
  get otherCount() {
    return this.voices.length;
  }
}

module.exports = { SpeakerTracker, cosine, normalize, average };
