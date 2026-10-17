import type { Metadata } from "next";
import { AdminPage } from "../../components/AdminPage.tsx";

export const metadata: Metadata = { title: "People · agentlink" };

export default function Admin() {
  return <AdminPage />;
}
