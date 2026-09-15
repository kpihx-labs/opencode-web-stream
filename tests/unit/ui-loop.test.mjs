import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The cockpit watches the whole document, because OpenCode Web replaces the
 * composer on navigation. Painting also writes to the document. Without a
 * guard those two facts form a cycle that freezes the tab, which is exactly
 * what shipped and what these tests exist to prevent from shipping again.
 *
 * A minimal DOM reproduces the browser rule that matters: `setAttribute` and
 * `textContent` queue a mutation record even when the value is unchanged.
 */

const bundle = readFileSync(new URL("../../dist/plugin.js", import.meta.url), "utf8");

function extract(name) {
  const start = bundle.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in the bundle`);
  let depth = 0;
  let i = bundle.indexOf("{", start);
  for (; i < bundle.length; i++) {
    if (bundle[i] === "{") depth++;
    else if (bundle[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return new Function(`${bundle.slice(start, i + 1)}\nreturn ${name};`)();
}

/** An element that reports every write, the way a real one does. */
function makeElement(onMutate, attrs = {}) {
  const store = new Map(Object.entries(attrs));
  let text = "";
  return {
    getAttribute: (name) => (store.has(name) ? store.get(name) : null),
    setAttribute(name, value) {
      store.set(name, value);
      onMutate();
    },
    hasAttribute: (name) => store.has(name),
    get textContent() {
      return text;
    },
    set textContent(value) {
      text = value;
      onMutate();
    },
  };
}

test("an identical attribute write still notifies, which is why the guard is needed", () => {
  let mutations = 0;
  const element = makeElement(() => mutations++, { title: "same" });
  element.setAttribute("title", "same");
  assert.equal(mutations, 1, "the browser queues a record regardless of the value");
});

test("setAttr writes only when the value differs", () => {
  const setAttr = extract("setAttr");
  let mutations = 0;
  const element = makeElement(() => mutations++, { title: "Live : je t'écoute" });

  setAttr(element, "title", "Live : je t'écoute");
  assert.equal(mutations, 0, "an unchanged title must not touch the DOM");

  setAttr(element, "title", "Live : je parle");
  assert.equal(mutations, 1);
  assert.equal(element.getAttribute("title"), "Live : je parle");

  setAttr(element, "aria-label", "Live");
  assert.equal(mutations, 2, "an absent attribute is written");
});

test("setText writes only when the text differs", () => {
  const setText = extract("setText");
  let mutations = 0;
  const element = makeElement(() => mutations++);

  setText(element, "🔊");
  assert.equal(mutations, 1);
  setText(element, "🔊");
  assert.equal(mutations, 1, "the same emoji must not replace the child nodes again");
  setText(element, "🔇");
  assert.equal(mutations, 2);
});

test("a hundred identical paints cause no mutation at all", () => {
  const setAttr = extract("setAttr");
  const setText = extract("setText");
  let mutations = 0;
  const button = makeElement(() => mutations++);
  const mute = makeElement(() => mutations++);

  const paintOnce = () => {
    setAttr(button, "data-state", "listening");
    setAttr(button, "title", "Live : je t'écoute");
    setAttr(button, "aria-pressed", "true");
    setAttr(mute, "title", "Narration active");
    setText(mute, "🔊");
  };

  paintOnce();
  const afterFirst = mutations;
  for (let i = 0; i < 100; i++) paintOnce();
  assert.equal(mutations, afterFirst, "a steady state must be silent, or the observer loops forever");
});

test("the cockpit's own nodes are recognised, so its writes never re-enter", () => {
  const isOurs = extract("isOurs");
  const ourButton = { hasAttribute: (n) => n === "data-opencode-stream", parentNode: null };
  assert.equal(isOurs(ourButton), true);

  const foreign = { hasAttribute: () => false, closest: () => null, parentNode: null };
  assert.equal(isOurs(foreign), false);
  assert.equal(isOurs(null), false);
});

test("the observer callback is guarded against its own paints", () => {
  // Three defences, all required: skip while painting, skip our own targets,
  // and coalesce the rest into one frame.
  assert.match(bundle, /if \(this\.painting\) return/);
  assert.match(bundle, /records\.every\(\(record\) => isOurs\(record\.target\)\)/);
  assert.match(bundle, /scheduleAttach/);
  assert.match(bundle, /requestAnimationFrame/);
  // The flag must outlive the call: records arrive at the next checkpoint.
  assert.match(bundle, /queueMicrotask/);
});
