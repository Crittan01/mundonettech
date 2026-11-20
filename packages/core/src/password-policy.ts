export interface PasswordPolicyIssue {
  code: "length" | "lowercase" | "uppercase" | "digit" | "symbol" | "control";
  message: string;
}

export function validatePasswordPolicy(password: string): PasswordPolicyIssue[] {
  const issues: PasswordPolicyIssue[] = [];
  if (password.length < 12 || password.length > 128) {
    issues.push({ code: "length", message: "Usa entre 12 y 128 caracteres." });
  }
  if (!/[a-z]/.test(password)) {
    issues.push({ code: "lowercase", message: "Incluye una letra minúscula." });
  }
  if (!/[A-Z]/.test(password)) {
    issues.push({ code: "uppercase", message: "Incluye una letra mayúscula." });
  }
  if (!/[0-9]/.test(password)) {
    issues.push({ code: "digit", message: "Incluye un número." });
  }
  if (!/[^A-Za-z0-9\s]/.test(password)) {
    issues.push({ code: "symbol", message: "Incluye un símbolo." });
  }
  if (/[\u0000-\u001f\u007f]/.test(password)) {
    issues.push({ code: "control", message: "No uses caracteres de control." });
  }
  return issues;
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 320 ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
    /[\u0000-\u001f\u007f]/.test(email)
  ) {
    throw new TypeError("Ingresa un correo electrónico válido.");
  }
  return email;
}
