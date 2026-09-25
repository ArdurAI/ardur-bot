import { Redirect, useLocalSearchParams } from "expo-router";
export default function BoardScreen() {
  const params = useLocalSearchParams<{ workspace?: string; item?: string }>();
  return <Redirect href={{ pathname: "/overview", params: { ...params, view: "board" } }} />;
}
