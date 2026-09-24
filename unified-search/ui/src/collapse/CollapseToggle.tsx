import type { ReactNode } from 'react';

import styles from './CollapseToggle.module.css';

/**
 * Show/hide control for a section of the page.
 *
 * A button rather than `<details>`, because the heading has to stay visible and clickable
 * while the body is hidden, and because two sections on this page need to collapse
 * independently without nesting interactive elements inside each other's summaries.
 *
 * `aria-expanded` and `aria-controls` are the whole reason this is a component rather than
 * two inline buttons: they have to agree with the element actually being hidden, and that
 * pairing is easy to get subtly wrong twice.
 */

export interface CollapseToggleProps {
  readonly open: boolean;
  readonly onToggle: () => void;
  /** Id of the region this controls. Must be the id of the collapsed element. */
  readonly controls: string;
  /** Names the section, so the button reads as "Hide answer" rather than "Hide". */
  readonly label: string;
}

export function CollapseToggle({
  open,
  onToggle,
  controls,
  label,
}: CollapseToggleProps): ReactNode {
  return (
    <button
      type="button"
      className={styles.toggle}
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
    >
      <span className={styles.chevron} aria-hidden="true">
        {open ? '▾' : '▸'}
      </span>
      {open ? `Hide ${label}` : `Show ${label}`}
    </button>
  );
}
