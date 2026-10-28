using System.Security.Cryptography;

namespace Mingle.Server;

internal static class PasswordHasher
{
    private const int Iterations = 310_000;
    private const int SaltSize = 16;
    private const int HashSize = 32;
    private static readonly byte[] MissingUserSalt = new byte[SaltSize];
    private static readonly byte[] MissingUserHash = Rfc2898DeriveBytes.Pbkdf2(
        "Mingle.invalid.account",
        MissingUserSalt,
        Iterations,
        HashAlgorithmName.SHA256,
        HashSize);

    public static (string Salt, string Hash) Create(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltSize);
        var hash = Rfc2898DeriveBytes.Pbkdf2(
            password,
            salt,
            Iterations,
            HashAlgorithmName.SHA256,
            HashSize);
        return (Convert.ToBase64String(salt), Convert.ToBase64String(hash));
    }

    public static bool Verify(string password, string? saltText, string? hashText)
    {
        byte[] salt;
        byte[] expected;
        try
        {
            salt = saltText is null ? MissingUserSalt : Convert.FromBase64String(saltText);
            expected = hashText is null ? MissingUserHash : Convert.FromBase64String(hashText);
        }
        catch (FormatException)
        {
            return false;
        }

        if (saltText is null || hashText is null)
        {
            Rfc2898DeriveBytes.Pbkdf2(
                password,
                MissingUserSalt,
                Iterations,
                HashAlgorithmName.SHA256,
                HashSize);
            return false;
        }

        if (salt.Length != SaltSize || expected.Length != HashSize)
        {
            return false;
        }

        var actual = Rfc2898DeriveBytes.Pbkdf2(
            password,
            salt,
            Iterations,
            HashAlgorithmName.SHA256,
            HashSize);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }
}
