import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";

import AuthLoading from "./loading";

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function AuthGroupLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <Suspense fallback={<AuthLoading />}>{children}</Suspense>;
}
