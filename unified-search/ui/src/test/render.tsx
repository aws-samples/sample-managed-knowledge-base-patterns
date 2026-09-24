import { render as rtlRender, type RenderOptions } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

/**
 * `render` with a router in place.
 *
 * Screens that show search results or a generated answer contain in-app links: a result
 * title opens the document viewer, and a citation marker opens the cited document. Those are
 * router navigations rather than anchors, deliberately, because the ID token is held in
 * memory and a full page load would land the reader on the viewer signed out.
 *
 * The consequence for tests is that anything rendering those components needs a router
 * ancestor or React Router throws while reading its context. Wrapping here rather than at
 * each call site keeps that detail out of the tests, which are about behavior.
 */

export interface RouterRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Starting URL, for screens that read the query string. Defaults to `/`. */
  readonly route?: string;
}

export function render(
  ui: ReactElement,
  options: RouterRenderOptions = {},
): ReturnType<typeof rtlRender> {
  const { route = '/', ...rest } = options;

  // A wrapper component rather than passing `MemoryRouter` directly, so `initialEntries` can
  // be threaded through. Nesting a second router inside a test instead throws, which is how
  // this came to exist.
  const Wrapper = ({ children }: { readonly children?: ReactNode }): ReactElement => (
    <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
  );

  return rtlRender(ui, { wrapper: Wrapper, ...rest });
}
