import Link from "next/link";
import type { ReactNode } from "react";

interface StoreNavLinkProps {
  href: string;
  prefetch?: boolean;
  exact?: boolean;
  className?: string;
  children: ReactNode;
}

export function StoreNavLink({
  href,
  prefetch,
  exact = false,
  className = "",
  children,
}: StoreNavLinkProps) {
  return (
    <Link
      href={href}
      {...(prefetch !== undefined ? { prefetch } : {})}
      data-store-nav={href}
      data-store-nav-exact={exact ? "1" : undefined}
      className={`inline-flex min-h-11 items-center rounded-md px-2.5 text-sm font-medium text-foreground transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-[current=page]:bg-secondary sm:min-h-9 ${className}`.trim()}
    >
      {children}
    </Link>
  );
}
