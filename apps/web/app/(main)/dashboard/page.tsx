"use client";
import { authClient } from "@/lib/auth";

export default function Page() {
  const { data: session } = authClient.useSession();
  console.log(session);
  if (session) {
    return (
      <div>
        {session.user.email}
        {session.user.name}
      </div>
    );
  } else {
    return <div className="text-2xl">no session</div>;
  }
}
