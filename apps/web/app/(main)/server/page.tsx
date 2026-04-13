/*
import { authClient } from "@/lib/auth"
import { cookies } from 'next/headers';

export default async function Page() {
  const cookie = await cookies();
  const { data: session, error } = await authClient.getSession({
    fetchOptions: {
      headers: {
        Cookie: cookie.toString()
      }
    }
  });
  console.log(session);
  return <div>
    hi
  </div>
}
 * */

/*
import axios from "axios";
import { cookies } from 'next/headers';

export default async function Page() {

  const cookie = await cookies();
  const fetchTodos = async () => {
    const todo = await axios.get("http://localhost:3001/api/v1/todos", {
      headers: {
        cookie: cookie.toString(),
      }
    },);
    console.log(todo.data);
  };
  await fetchTodos();
  return <div>
    hi
  </div>
}
 * */
