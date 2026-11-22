import http from "k6/http";
import exec from "k6/execution";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

import { loadPlan } from "./plan.js";

const gateway = __ENV.LOAD_GATEWAY_URL;
const token = __ENV.LOAD_GATEWAY_TOKEN;
const baseUrl = __ENV.LOAD_BASE_URL;
const unexpected = new Counter("unexpected_outcomes");
const deadlocks = new Counter("domain_deadlocks");
const successes = new Counter("domain_successes");
const rejections = new Counter("expected_domain_rejections");
const storefrontLatency = new Trend("storefront_latency", true);

export const options = {
  setupTimeout: "30s",
  thresholds: {
    checks: ["rate==1"],
    http_req_failed: ["rate==0"],
    http_req_duration: ["p(95)<15000"],
    storefront_latency: ["p(95)<3000"],
    unexpected_outcomes: ["count==0"],
    domain_deadlocks: ["count==0"],
    domain_successes: [`count==${loadPlan.expectedSuccesses}`],
    expected_domain_rejections: [`count==${loadPlan.expectedRejections}`],
  },
  scenarios: {
    storefront: {
      executor: "constant-vus",
      exec: "storefront",
      vus: 4,
      duration: "15s",
    },
    stock: {
      executor: "shared-iterations",
      exec: "stock",
      vus: 8,
      iterations: loadPlan.stockAttempts,
      maxDuration: "2m",
    },
    coupons: {
      executor: "shared-iterations",
      exec: "coupons",
      vus: 8,
      iterations: loadPlan.couponAttempts,
      maxDuration: "2m",
    },
    checkout: {
      executor: "shared-iterations",
      exec: "checkout",
      vus: 8,
      iterations: loadPlan.checkoutAttempts,
      maxDuration: "2m",
    },
    payments: {
      executor: "shared-iterations",
      exec: "payments",
      vus: 8,
      iterations: loadPlan.paymentAttempts,
      maxDuration: "2m",
    },
  },
};

export function setup() {
  const response = http.get(`${gateway}/fixtures`, {
    headers: { Authorization: `Bearer ${token}` },
    responseCallback: http.expectedStatuses(200),
  });
  check(response, { "load fixtures available": (target) => target.status === 200 });
  return response.json();
}

function operation(type, input) {
  const response = http.post(`${gateway}/operation`, JSON.stringify({ type, input }), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    responseCallback: http.expectedStatuses(200, 409),
    timeout: "120s",
    tags: { domain_operation: type },
  });
  let payload = {};
  try {
    payload = response.json();
  } catch {
    unexpected.add(1);
  }
  const valid = response.status === 200 || response.status === 409;
  const rejected = response.status === 409 && payload.outcome === "rejected";
  const succeeded = response.status === 200 && payload.outcome === "ok";
  const deadlock = payload.code === "40P01" || payload.errorName === "40P01";
  deadlocks.add(deadlock ? 1 : 0);
  unexpected.add(valid && (succeeded || rejected) && !deadlock ? 0 : 1);
  successes.add(succeeded ? 1 : 0);
  rejections.add(rejected ? 1 : 0);
  check(response, {
    [`${type} has an expected domain outcome`]: () => valid && (succeeded || rejected),
    [`${type} has no deadlock`]: () => !deadlock,
  });
}

export function storefront() {
  const started = Date.now();
  const home = http.get(`${baseUrl}/`, { tags: { surface: "standalone" } });
  storefrontLatency.add(Date.now() - started);
  check(home, {
    "standalone home is available": (response) =>
      response.status === 200 && response.body.includes("MundoNetTech"),
  });
  const readiness = http.get(`${baseUrl}/api/health/ready`, {
    tags: { surface: "standalone" },
  });
  check(readiness, {
    "standalone readiness is available": (response) =>
      response.status === 200 && response.body.includes('"ready"'),
  });
}

export function stock(data) {
  const index = exec.scenario.iterationInTest;
  const movements = [
    { ...data.stock.first, quantity: 1 },
    { ...data.stock.second, quantity: 1 },
  ];
  if (index % 2 === 1) movements.reverse();
  operation("stock.reserve", { operationKey: `k6-stock-${index}`, items: movements });
}

export function coupons(data) {
  const index = exec.scenario.iterationInTest;
  operation("coupon.apply", {
    cartId: data.coupons.cartIds[index],
    code: data.coupons.code,
  });
}

export function checkout(data) {
  const index = exec.scenario.iterationInTest;
  operation("order.checkout", data.checkout.submissions[index]);
}

export function payments(data) {
  const index = exec.scenario.iterationInTest;
  const order = data.payments.orders[Math.floor(index / 2)];
  operation("payment.storeCredit", {
    orderId: order.orderId,
    amountCents: order.totalCents,
    idempotencyKey: `k6-payment-${order.orderId}-${index % 2}`,
  });
}
