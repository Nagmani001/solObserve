import { authClient } from "@/lib/auth";
import { cookies } from "next/headers";

export default async function Page() {
  const cookie = await cookies();
  const { data: session, error } = await authClient.getSession({
    fetchOptions: {
      headers: {
        Cookie: cookie.toString(),
      },
    },
  });
  console.log(session);
  return <div>hi {session?.user.email}</div>;
}
