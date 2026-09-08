import type { ReactNode } from "react";
import { Link } from "@remix-run/react";
import styles from "~/routes/_index/styles.module.css";

/**
 * Frame for the pages that live outside the Shopify admin — privacy policy,
 * terms, support. They are linked from the App Store listing and from the
 * app, so they render without App Bridge, Polaris or a session, in both
 * languages on one page.
 */
export function PublicPage({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className={styles.index} style={{ alignItems: "flex-start" }}>
      <div className={styles.content} style={{ maxWidth: "48rem" }}>
        <nav style={{ display: "flex", gap: "1rem", fontSize: "0.9rem", marginBottom: "1.5rem" }}>
          <Link to="/">DropshipHub</Link>
          <Link to="/support">Support</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </nav>
        <h1 className={styles.heading}>{title}</h1>
        {subtitle && <p className={styles.text}>{subtitle}</p>}
        <div className={styles.prose}>{children}</div>
      </div>
    </div>
  );
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: "1.75rem" }}>
      <h2 style={{ fontSize: "1.2rem", margin: "0 0 0.5rem" }}>{heading}</h2>
      {children}
    </section>
  );
}

export function LanguageDivider({ label }: { label: string }) {
  return (
    <hr
      style={{ border: 0, borderTop: "1px solid #e1e3e5", margin: "2.5rem 0 1.5rem", overflow: "visible", textAlign: "center", height: 0 }}
      data-label={label}
    />
  );
}
