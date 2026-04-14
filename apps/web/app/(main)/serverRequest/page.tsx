import axios from "axios";
import { cookies } from "next/headers";

export default async function Page() {
  const cookie = await cookies();
  const todo = await axios.get("http://localhost:3001/api/v1/todos", {
    headers: {
      cookie: cookie.toString(),
    },
  });
  console.log(todo.data.todo.todos[0].todo);
  return (
    <div>
      hi
      {/*@ts-ignore*/}
      {todo.data.todo.todos[0].todo}
    </div>
  );
}
