import { AppLoader } from "../components/AppLoader.tsx";

// The signed-in app. middleware.ts sends visitors without a session cookie to /login; the API re-checks
// every request, and the app signs out on a 401.
export default function Home() {
  return <AppLoader />;
}
