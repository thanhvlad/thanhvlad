import type { ActionFunctionArgs } from "@remix-run/node";
import { handleWebhookRequest } from "~/lib/webhook-route.server";

export const action = (args: ActionFunctionArgs) => handleWebhookRequest(args);
