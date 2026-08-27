/**
 * Where the navigation can go, declared once for both bars that render it.
 *
 * The landing page and the console each have a top bar, and they used to be unrelated: the landing
 * nav listed four anchors, the console's held a status tag and two buttons. Keeping the destinations
 * in one list is not tidiness — a nav item present on one screen and missing on the other reads as a
 * broken link, and the person who adds "Blog" to the landing page has no reason to think of the
 * console at all.
 *
 * What differs between the two bars is which items they can honour, and that is what {@link NavItem}
 * encodes rather than leaving to each caller's judgement:
 *
 *   `anchor` — an in-page jump. Only meaningful on the landing page; on the console `#how` scrolls
 *              to nothing, so those items are filtered out rather than rendered as dead links.
 *   `view`   — a console pane. On the console it switches the view; on the landing page it is a
 *              link into the console that arrives with that pane already open.
 *   `href`   — a real URL somewhere else. Identical on both, and always a real anchor so it
 *              behaves like one: middle-click, copy link, open in a new tab.
 *
 * The external hosts here were each checked to be live and public before being listed. A nav is the
 * one place a 404 is unambiguously the site's own fault.
 */

import type { RailView } from '../ui/ChatList'

export type NavItem =
  | { label: string; kind: 'anchor'; to: string }
  | { label: string; kind: 'view'; view: RailView }
  | { label: string; kind: 'href'; href: string }

/**
 * An item any bar can render — everything except an in-page anchor.
 *
 * Named so `navFor('console')` can return this narrower type rather than `NavItem[]`. Without it the
 * console's bar has to handle an `anchor` case that its own filter has already removed, and that
 * branch is unreachable code the compiler nonetheless requires — which is how a dead-link fallback
 * gets written and then quietly becomes reachable when the filter changes.
 */
export type LinkableNavItem = Exclude<NavItem, { kind: 'anchor' }>

/**
 * The order is the argument, so it is worth stating: what this is, then what it costs, then what is
 * in it, then where to read more, then the parent brand.
 *
 * "Platform" is jarvisclaw.ai — the account, the keys, the billing. It belongs in the nav because
 * this console deliberately has no sign-up form of its own: a page that asks for platform
 * credentials teaches visitors that any page may, so the only honest answer to "where do I get an
 * account" is a link to the platform itself.
 */
export const NAV: NavItem[] = [
  { label: 'How it works', kind: 'anchor', to: '#how' },
  { label: 'Compare', kind: 'anchor', to: '#compare' },
  { label: 'Pricing', kind: 'anchor', to: '#pay' },
  { label: 'Marketplace', kind: 'view', view: 'marketplace' },
  { label: 'Gallery', kind: 'view', view: 'gallery' },
  { label: 'FAQ', kind: 'anchor', to: '#faq' },
  { label: 'Docs', kind: 'href', href: 'https://docs.jarvisclaw.ai' },
  { label: 'Blog', kind: 'href', href: 'https://blog.jarvisclaw.ai' },
  { label: 'Platform', kind: 'href', href: 'https://jarvisclaw.ai' },
]

/**
 * The subset a bar can render: the console cannot honour an in-page anchor.
 *
 * Overloaded so the console's return type excludes `anchor` at compile time. The runtime filter alone
 * does not narrow anything, so the caller would still have to write a branch for a case that cannot
 * arrive — and a fallback for an impossible case is a link that goes nowhere, waiting for the filter
 * to change.
 */
export function navFor(bar: 'console'): LinkableNavItem[]
export function navFor(bar: 'landing'): NavItem[]
export function navFor(bar: 'landing' | 'console'): NavItem[] {
  return bar === 'landing'
    ? NAV
    : NAV.filter((i): i is LinkableNavItem => i.kind !== 'anchor')
}
