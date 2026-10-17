import type { Metadata } from "next";
import { LoginForm } from "../../components/LoginForm.tsx";

export const metadata: Metadata = { title: "Sign in · agentlink" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  return <LoginForm reason={reason} />;
}
