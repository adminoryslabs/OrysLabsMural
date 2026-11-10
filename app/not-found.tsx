import Link from "next/link";

/**
 * The 404. A board the viewer may not open resolves to `notFound()` on purpose,
 * so this page is also what an outsider sees: it must not say whether the board
 * exists.
 */
export default function NotFound() {
  return (
    <div className="status-page">
      <span className="brand-mark" aria-hidden="true" />
      <h1>Page not found</h1>
      <p className="landing-lede">
        This page does not exist, or you do not have access to it.
      </p>
      <Link className="btn-solid" href="/">
        Back to your boards
      </Link>
    </div>
  );
}
