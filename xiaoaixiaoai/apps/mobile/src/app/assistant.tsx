import { Redirect } from "expo-router";

/** herdrpocket://assistant (tapping an alert) lands on the assistant tab. */
export default function AssistantLink() {
  return <Redirect href="/" />;
}
