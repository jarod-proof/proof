import { cleanup, configure } from "@testing-library/react"
import { afterEach, expect } from "vitest"

import { fakeViolations } from "./fake-hq"

// A fixture the fake of hq refuses to answer with would reach the client as an unreachable hq and
// could pass a test that expects an error: fail the test that caused it, whatever it asserted.
// A test that provokes one on purpose empties `fakeViolations` itself.
afterEach(() => {
  const seen = fakeViolations.splice(0)
  expect(seen.map((e) => e.message)).toEqual([])
})

// Node tests (hq's own, the contract test) share this file: only a jsdom test has a document.
if (typeof document !== "undefined") {
  // Turbo runs every package's tests at once; under that load a first render can pass Testing
  // Library's 1s default for findBy*/waitFor. 5s keeps real failures failing.
  configure({ asyncUtilTimeout: 5000 })

  // Vitest runs without globals, so Testing Library's automatic cleanup is not registered.
  afterEach(() => {
    cleanup()
  })

  // jsdom has neither; cmdk-style lists and the layout hooks need both.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class implements ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {}
  }
  // The router restores scroll on navigation; jsdom's window.scrollTo only logs 'not implemented'.
  window.scrollTo = () => {}
  // jsdom has no matchMedia. Wide and light by default.
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }
}
