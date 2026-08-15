-- CreateTable
CREATE TABLE "auth_attempts" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL,
    "windowStart" TEXT NOT NULL,
    "lockedUntil" TEXT,
    "updatedAt" TEXT NOT NULL,

    CONSTRAINT "auth_attempts_pkey" PRIMARY KEY ("key")
);
