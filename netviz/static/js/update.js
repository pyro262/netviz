// "UPDATE AVAILABLE" in the lower left, when the collector says a newer
// release exists.
//
// The one piece of text on this display that is not about the network, so it
// has to earn its place twice over: legible to someone who walks up and looks
// at it, and invisible to someone watching the globe. It sits in the corner
// furthest from where arcs converge, at low opacity, in the map's own dim
// violet rather than the alarm amber -- an available update is not an alarm,
// and borrowing the alarm colour would devalue the colour that is.
//
// It fades in over 2s rather than appearing between frames. Something that
// blinks into existence on a wall display reads as a glitch; something that
// arrives slowly reads as a state change.

const FADE_SECONDS = 2;

/**
 * Should the watermark show, given a /build.json body?
 *
 * Pure, so node --test covers the decision without a DOM. False for every
 * uncertain case: a collector too old to serve the field, a failed poll (null),
 * a malformed body. An indicator that appears when something breaks is one
 * everybody learns to ignore.
 */
export function updateAvailable(build) {
  if (!build || typeof build !== 'object') return false;
  const u = build.update;
  if (!u || typeof u !== 'object') return false;
  return u.available === true;
}

/**
 * The text to show. `latest` is included when the collector reported it, so
 * someone standing at the wall knows which version to go and get, but the
 * label alone is the point and a missing tag never blanks it.
 */
export function updateLabel(build) {
  if (!updateAvailable(build)) return null;
  const tag = build.update.latest;
  return typeof tag === 'string' && tag ? `UPDATE AVAILABLE ${tag}` : 'UPDATE AVAILABLE';
}

/**
 * Mount the watermark element. Returns a function taking a /build.json body.
 *
 * The element is created once and toggled, not created and destroyed: the
 * fade is a CSS transition on opacity, and an element that is removed from the
 * DOM has nothing to transition from.
 */
export function mountUpdateMark(parent = document.body) {
  const node = document.createElement('div');
  node.className = 'update-mark';
  node.style.transitionDuration = `${FADE_SECONDS}s`;
  parent.append(node);

  let shown = null;
  return (build) => {
    const label = updateLabel(build);
    if (label === shown) return;
    shown = label;
    if (label) {
      node.textContent = label;
      node.classList.add('on');
    } else {
      // Text left in place while it fades out, so the last frame of the
      // transition is the label going dim rather than an empty box.
      node.classList.remove('on');
    }
  };
}
