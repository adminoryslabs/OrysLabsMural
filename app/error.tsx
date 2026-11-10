"use client";
import Link from "next/link";

/**
 * The error boundary. It keeps the brand frame and offers the only two useful
 * actions: retry the segment, or go back to the board list. The digest is shown
 * because it is the only thing that matches this failure to a server log.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="status-page">
      <span className="brand-mark" aria-hidden="true" />
      <h1>Something went wrong</h1>
      <p className="landing-lede">
        The page could not be loaded. Your boards and their content are safe.
      </p>
      {error.digest ? (
        <p className="muted">Reference: {error.digest}</p>
      ) : null}
      <div className="row">
        <button className="btn-solid" type="button" onClick={() => reset()}>
          Try again
        </button>
        <Link className="btn-quiet" href="/">
          Back to your boards
        </Link>
      </div>
    </div>
  );
}
