using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// CI-only process boundary. A limited scheduled task is still elevated when UAC is disabled.
public static class RestrictedProcess
{
    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, StandardInput, StandardOutput, StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSidToSid(string text, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disableCount,
        [In] SidAndAttributes[] disable, uint deleteCount, IntPtr delete, uint restrictCount,
        IntPtr restrict, out IntPtr restricted);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(IntPtr token, int kind,
        ref SidAndAttributes information, uint size);
    [DllImport("advapi32.dll")]
    private static extern uint GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUser(IntPtr token, string application,
        StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
        uint flags, IntPtr environment, string directory, ref StartupInfo startup,
        out ProcessInformation information);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    private static void Check(bool success)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static int Run(string executable, string arguments, string directory, int timeoutMs)
    {
        IntPtr original = IntPtr.Zero, restricted = IntPtr.Zero;
        IntPtr administrators = IntPtr.Zero, medium = IntPtr.Zero;
        ProcessInformation owned = new ProcessInformation();
        Process process = null;
        try
        {
            // Duplicate this process's token; no account, password or global policy change.
            Check(OpenProcessToken(GetCurrentProcess(), 0x008B, out original));
            Check(ConvertStringSidToSid("S-1-5-32-544", out administrators));
            var disabled = new[] { new SidAndAttributes { Sid = administrators } };
            // DISABLE_MAX_PRIVILEGE plus a deny-only Administrators SID also works with UAC off.
            Check(CreateRestrictedToken(original, 1, 1, disabled, 0, IntPtr.Zero,
                0, IntPtr.Zero, out restricted));
            Check(ConvertStringSidToSid("S-1-16-8192", out medium));
            var integrity = new SidAndAttributes { Sid = medium, Attributes = 0x20 };
            Check(SetTokenInformation(restricted, 25, ref integrity,
                (uint)Marshal.SizeOf<SidAndAttributes>() + GetLengthSid(medium)));
            var startup = new StartupInfo { Size = (uint)Marshal.SizeOf<StartupInfo>() };
            var command = new StringBuilder("\"" + executable + "\" " + arguments);
            // Suspend until we have the exact owned process handle. Children inherit this token.
            Check(CreateProcessAsUser(restricted, executable, command, IntPtr.Zero, IntPtr.Zero,
                false, 0x08000404, IntPtr.Zero, directory, ref startup, out owned));
            process = Process.GetProcessById((int)owned.ProcessId);
            if (process.Handle == IntPtr.Zero) throw new InvalidOperationException("Missing owned process handle");
            if (ResumeThread(owned.Thread) == uint.MaxValue)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!process.WaitForExit(timeoutMs))
                throw new TimeoutException("Unprivileged acceptance process timed out");
            return process.ExitCode;
        }
        finally
        {
            // Only the process created above and its descendants may be stopped.
            if (process != null)
            {
                try
                {
                    if (!process.HasExited) { process.Kill(true); process.WaitForExit(); }
                }
                finally { process.Dispose(); }
            }
            else if (owned.Process != IntPtr.Zero) TerminateProcess(owned.Process, 1);
            if (owned.Thread != IntPtr.Zero) CloseHandle(owned.Thread);
            if (owned.Process != IntPtr.Zero) CloseHandle(owned.Process);
            if (restricted != IntPtr.Zero) CloseHandle(restricted);
            if (original != IntPtr.Zero) CloseHandle(original);
            if (medium != IntPtr.Zero) LocalFree(medium);
            if (administrators != IntPtr.Zero) LocalFree(administrators);
        }
    }
}
