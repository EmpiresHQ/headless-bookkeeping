export function BrandMark({ className = '' }: { readonly className?: string }) {
  return (
    <span
      className={`flex items-center justify-center rounded-lg bg-accent-deep ${className}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5">
        <path
          className="fill-surface"
          d="M5.4 6.1c2.5 0 4.6.9 5.7 2.5v9.2c-1.3-1.1-3.1-1.7-5.7-1.7V6.1Z"
        />
        <path
          className="fill-surface"
          d="M18.6 6.1c-2.5 0-4.6.9-5.7 2.5v9.2c1.3-1.1 3.1-1.7 5.7-1.7V6.1Z"
        />
        <path className="fill-accent-deep" d="M11.15 8.15h1.7v9.7h-1.7z" />
        <path className="fill-signal" d="M12 9.75 15 12.6 12 15.45 9 12.6z" />
        <path
          className="fill-accent-deep"
          d="m11.65 13.55-1.2-1.15.6-.65.6.57 1.36-1.47.64.58-2 2.12Z"
        />
      </svg>
    </span>
  );
}
