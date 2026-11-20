import { Suspense, type ReactNode } from "react";

import AccountLoading from "./loading";

export default function CustomerAccountLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <Suspense fallback={<AccountLoading />}>{children}</Suspense>;
}
