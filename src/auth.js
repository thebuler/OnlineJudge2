import { createClient } from "@supabase/supabase-js";

const loginButton = document.querySelector("#googleLogin");
const loginError = document.querySelector("#loginError");
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

function showError(message) {
  loginError.textContent = message;
  loginError.hidden = false;
}

function sendSession(session) {
  window.dispatchEvent(new CustomEvent("codeon:auth", {
    detail: { user: session?.user ?? null }
  }));
}

function showProviderError() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error_description") || params.get("error");
  if (!error) return;

  const message = /provider.*not enabled|unsupported provider/i.test(error)
    ? "Supabase 설정에서 Google 로그인 제공자를 먼저 켜주세요."
    : error === "access_denied"
      ? "Google 로그인이 취소됐어요. 다시 시도해 주세요."
      : "Google 로그인을 완료하지 못했어요. Supabase 설정을 확인해 주세요.";
  showError(message);
  window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
}

if (!supabaseUrl || !supabaseKey) {
  loginButton.disabled = true;
  showError("Supabase 연결 설정이 필요합니다. 프로젝트 URL과 publishable key를 확인해 주세요.");
} else {
  let supabase;
  try {
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
  } catch {
    loginButton.disabled = true;
    showError("Supabase 연결 정보가 올바르지 않습니다. 프로젝트 URL과 publishable key를 확인해 주세요.");
  }

  if (supabase) {
    supabase.auth.onAuthStateChange((_event, session) => sendSession(session));
    supabase.auth.getSession().then(({ data: { session }, error }) => {
      if (error) showError("로그인 상태를 확인하지 못했어요. 페이지를 새로고침해 주세요.");
      sendSession(session);
      showProviderError();
    }).catch(() => showError("로그인 상태를 확인하지 못했어요. 페이지를 새로고침해 주세요."));

    loginButton.addEventListener("click", async () => {
      loginButton.disabled = true;
      loginError.hidden = true;
      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: window.location.origin,
          queryParams: { prompt: "select_account" }
        }
      });
      if (signInError) {
        showError("Google 로그인 요청을 시작하지 못했어요. Supabase 제공자 설정을 확인해 주세요.");
        loginButton.disabled = false;
      }
    });

    document.querySelector("#logoutButton").addEventListener("click", async () => {
      const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
      if (signOutError) {
        window.dispatchEvent(new CustomEvent("codeon:notice", {
          detail: { message: "로그아웃하지 못했어요. 다시 시도해 주세요." }
        }));
      }
    });
  }
}
