package cn.anote.mobile;
import org.junit.Test;
import static org.junit.Assert.*;

public class OriginPolicyTest {
    @Test public void onlyCurrentServerMayGenerateBlobExports() {
        assertTrue(OriginPolicy.sameBlobOrigin("blob:https://notes.example/uuid", "https://notes.example"));
        assertFalse(OriginPolicy.sameBlobOrigin("blob:https://notes.example.evil/uuid", "https://notes.example"));
        assertFalse(OriginPolicy.sameBlobOrigin("blob:https://notes.example@evil.example/uuid", "https://notes.example"));
        assertFalse(OriginPolicy.sameBlobOrigin("blob:https://notes.example:8443/uuid", "https://notes.example"));
        assertFalse(OriginPolicy.sameBlobOrigin("blob:null/uuid", "https://notes.example"));
        assertFalse(OriginPolicy.sameBlobOrigin("https://notes.example/uuid", "https://notes.example"));
        assertFalse(OriginPolicy.sameBlobOrigin(null, "https://notes.example"));
    }
    @Test public void normalizesOnlyTrueOrigins() {
        assertNull(OriginPolicy.origin(null));
        assertEquals("https://notes.example", OriginPolicy.server(" HTTPS://NOTES.EXAMPLE:443/ ", false, ""));
        assertEquals("https://[::1]:9443", OriginPolicy.server("https://[::1]:9443", false, ""));
        assertFalse(OriginPolicy.sameOrigin("https://notes.example.evil/path", "https://notes.example"));
        assertFalse(OriginPolicy.sameOrigin("https://notes.example@evil.example/path", "https://notes.example"));
        assertFalse(OriginPolicy.sameOrigin("https://notes.example:8443/path", "https://notes.example"));
        assertFalse(OriginPolicy.sameOrigin("file:///etc/passwd", "https://notes.example"));
        assertFalse(OriginPolicy.sameOrigin("javascript:alert(1)", "https://notes.example"));
    }
    @Test public void rejectsServerCredentialsPathsAndMixedOrigins() {
        for (String value : new String[]{"https://u:p@notes.example", "https://notes.example/x", "https://notes.example?token=secret", "https://notes.example#x", "http://notes.example", "https://notes.example:0", "content://notes.example", "https://notes.example/../"}) {
            try { OriginPolicy.server(value, false, ""); fail("Accepted: " + value); }
            catch (IllegalArgumentException expected) {}
        }
    }
    @Test public void debugHttpIsOnlyTheExplicitBuildOrigin() {
        assertEquals("http://127.0.0.1:3150", OriginPolicy.server("http://127.0.0.1:3150", true, "http://127.0.0.1:3150"));
        for (String value : new String[]{"http://127.0.0.1:3151", "http://other.example:3150", "http://127.0.0.1.evil:3150"}) {
            try { OriginPolicy.server(value, true, "http://127.0.0.1:3150"); fail("Accepted: " + value); }
            catch (IllegalArgumentException expected) {}
        }
        try { OriginPolicy.server("http://127.0.0.1:3150", false, "http://127.0.0.1:3150"); fail("Release accepted HTTP"); }
        catch (IllegalArgumentException expected) {}
    }
    @Test public void authenticationMustStartAtTheSelectedServer() {
        assertTrue(OriginPolicy.isAuthenticationStart("https://notes.example/api/auth/casdoor/start?ticket=x", "https://notes.example"));
        assertFalse(OriginPolicy.isAuthenticationStart("https://evil.example/api/auth/casdoor/start", "https://notes.example"));
        assertFalse(OriginPolicy.isAuthenticationStart("https://notes.example/api/auth/casdoor/start/other", "https://notes.example"));
        assertFalse(OriginPolicy.isAuthenticationStart("https://notes.example/api/auth/casdoor/start/../other", "https://notes.example"));
    }
    @Test public void filenamesCannotContainPathsOrControlCharacters() {
        assertEquals(".._secret_name_.pdf", OriginPolicy.safeFilename("../secret\\name\n.pdf"));
        assertEquals("附件", OriginPolicy.safeFilename(".."));
        assertEquals("附件", OriginPolicy.safeFilename(null));
    }
    @Test public void printingUsesTheNoteTitleBeforeThePlatformTitle() {
        assertEquals("移动端研究记录", OriginPolicy.printTitle("  移动端研究记录  ", "ANote"));
        assertEquals("研究_笔记_第1章", OriginPolicy.printTitle("研究/笔记:第1章", "ANote"));
        assertEquals("ANote", OriginPolicy.printTitle("", "ANote"));
        assertEquals("笔记", OriginPolicy.printTitle(null, null));
    }
}
