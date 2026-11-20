/**
 * The sign-in page's script, served at /admin/login.js. hq has no web app, so a founder signs in
 * here, through better-auth's own endpoint (its origin check and rate limit apply, and the cookie
 * it sets is the session the admin pages read). The script holds no credentials handling of its
 * own: it posts the form as JSON and follows `next`, only ever to a path under /admin/.
 */
export const LOGIN_SCRIPT = `
const form = document.getElementById("login")
const error = document.getElementById("login-error")
form.addEventListener("submit", async (event) => {
  event.preventDefault()
  error.hidden = true
  const data = new FormData(form)
  try {
    const res = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
    })
    if (res.ok) {
      const next = form.dataset.next || ""
      location.assign(next.startsWith("/admin/") && !next.startsWith("//") ? next : "/admin/proposals")
      return
    }
    error.textContent = res.status === 401 ? "Wrong email or password." : "Could not sign in."
  } catch {
    error.textContent = "Could not reach the server."
  }
  error.hidden = false
})
`
