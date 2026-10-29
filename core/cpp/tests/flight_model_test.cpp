// Standalone tests for DroneFlightModel.h. Build and run: core/cpp/tests/run.sh
#include "../DroneFlightModel.h"

#include <cstdio>
#include <cmath>

using namespace DroneSim;

static int Failures = 0;
static int Checks = 0;

#define CHECK(cond, ...)                                    \
	do                                                      \
	{                                                       \
		++Checks;                                           \
		if (!(cond))                                        \
		{                                                   \
			++Failures;                                     \
			std::printf("FAIL %s:%d  ", __FILE__, __LINE__); \
			std::printf(__VA_ARGS__);                       \
			std::printf("\n");                              \
		}                                                   \
	} while (0)

static void Run(Model& M, const Sticks& In, double Seconds, double Dt = 1.0 / 60.0)
{
	const int N = static_cast<int>(Seconds / Dt + 0.5);
	for (int I = 0; I < N; ++I)
	{
		M.Step(In, Dt);
	}
}

static bool Finite(const State& S)
{
	return std::isfinite(S.Position.X) && std::isfinite(S.Position.Y) && std::isfinite(S.Position.Z) &&
		std::isfinite(S.Velocity.X) && std::isfinite(S.Attitude.W);
}

static void HoldModeHovers()
{
	Model M;
	M.Reset(Vec3(0, 0, 10));
	Run(M, Sticks(), 10.0);
	const State& S = M.GetState();
	CHECK(std::fabs(S.Position.Z - 10.0) < 0.1, "hold hover drifted to z=%.3f", S.Position.Z);
	CHECK(S.Velocity.Length() < 0.05, "hold hover still moving %.3f m/s", S.Velocity.Length());
	CHECK(M.TiltDeg() < 1.0, "hold hover tilted %.2f deg", M.TiltDeg());
}

static void AngleModeHoverStick()
{
	Model M;
	M.SetMode(FlightMode::Angle);
	M.Reset(Vec3(0, 0, 50));
	Sticks In;
	In.Throttle = M.HoverStick();
	Run(M, In, 3.0);
	CHECK(std::fabs(M.GetState().Velocity.Z) < 0.05, "hover stick does not hover: vz=%.3f", M.GetState().Velocity.Z);
	CHECK(std::fabs(M.GetParams().ThrustToWeight * (In.Throttle + 1.0) * 0.5 - 1.0) < 1e-9, "hover stick maths");
}

static void AngleModeTiltLimitAndForward()
{
	Model M;
	M.SetMode(FlightMode::Angle);
	M.Reset(Vec3(0, 0, 100));
	Sticks In;
	In.Throttle = M.HoverStick();
	In.Pitch = 1.0;
	Run(M, In, 2.0);
	const double Max = M.GetParams().MaxTiltDeg;
	CHECK(std::fabs(M.TiltDeg() - Max) < 2.0, "full pitch tilt %.1f, expected %.1f", M.TiltDeg(), Max);
	CHECK(M.GetState().Velocity.X > 3.0, "pitch forward should fly forward, vx=%.2f", M.GetState().Velocity.X);
	CHECK(std::fabs(M.GetState().Velocity.Y) < 0.2, "pitch forward drifted sideways vy=%.2f", M.GetState().Velocity.Y);
}

static void AngleModeRollRight()
{
	Model M;
	M.SetMode(FlightMode::Angle);
	M.Reset(Vec3(0, 0, 100));
	Sticks In;
	In.Throttle = M.HoverStick();
	In.Roll = 1.0;
	Run(M, In, 2.0);
	CHECK(M.GetState().Velocity.Y < -2.0, "roll right should move right (negative y), vy=%.2f", M.GetState().Velocity.Y);
}

static void AcroRates()
{
	Model M(Fpv5InchPreset());
	M.SetMode(FlightMode::Acro);
	M.Reset(Vec3(0, 0, 100));
	Sticks In;
	In.Throttle = M.HoverStick();
	In.Roll = 1.0;
	Run(M, In, 0.3);
	const double Rate = RadToDeg(M.GetState().BodyRates.X);
	CHECK(std::fabs(Rate - 670.0) < 30.0, "acro full roll rate %.0f deg/s", Rate);
	In.Roll = 0.0;
	Run(M, In, 0.3);
	CHECK(std::fabs(RadToDeg(M.GetState().BodyRates.X)) < 5.0, "acro rate should stop when stick released");
}

static void YawRightTurnsClockwise()
{
	Model M;
	M.Reset(Vec3(0, 0, 10));
	Sticks In;
	In.Yaw = 1.0;
	Run(M, In, 0.5);
	CHECK(M.Heading() < -0.3, "yaw right should reduce heading, got %.3f rad", M.Heading());
}

static void HoldModeSpeedAndStop()
{
	Model M;
	M.Reset(Vec3(0, 0, 30));
	Sticks In;
	In.Pitch = 1.0;
	Run(M, In, 8.0);
	const double V = M.GetState().Velocity.X;
	const double Vmax = M.GetParams().HoldMaxSpeedMs;
	CHECK(std::fabs(V - Vmax) < 0.15 * Vmax, "hold forward speed %.2f, expected about %.1f", V, Vmax);
	CHECK(std::fabs(M.GetState().Position.Z - 30.0) < 1.5, "hold forward lost height: z=%.2f", M.GetState().Position.Z);
	Run(M, Sticks(), 8.0);
	CHECK(M.GetState().Velocity.Length() < 0.2, "hold should stop after release, v=%.2f", M.GetState().Velocity.Length());
}

static void HoldModeBrakesInsteadOfSpringingBack()
{
	Model M;
	M.Reset(Vec3(0, 0, 10));
	Sticks Up;
	Up.Throttle = 1.0;
	Run(M, Up, 1.0);
	const double ReleasedAt = M.GetState().Position.Z;
	Run(M, Sticks(), 4.0);
	CHECK(M.GetState().Position.Z >= ReleasedAt, "released climb should brake and hold above %.2f, got %.2f", ReleasedAt, M.GetState().Position.Z);
	Sticks Fwd;
	Fwd.Pitch = 1.0;
	Run(M, Fwd, 3.0);
	const double StickReleasedX = M.GetState().Position.X;
	Run(M, Sticks(), 6.0);
	CHECK(M.GetState().Position.X >= StickReleasedX, "released forward should not fly back, x %.2f < %.2f", M.GetState().Position.X, StickReleasedX);
	CHECK(M.GetState().Velocity.Length() < 0.2, "should be stopped after braking");
}

static void HoldModeClimb()
{
	Model M;
	M.Reset(Vec3(0, 0, 5));
	Sticks In;
	In.Throttle = 1.0;
	Run(M, In, 4.0);
	CHECK(std::fabs(M.GetState().Velocity.Z - M.GetParams().HoldMaxClimbMs) < 0.4, "climb rate %.2f", M.GetState().Velocity.Z);
}

static void HoldModeFightsWind()
{
	Model M;
	M.Reset(Vec3(0, 0, 20));
	M.SetWind(Vec3(0, 6.0, 0));
	Run(M, Sticks(), 30.0);
	const State& S = M.GetState();
	const double Drift = std::sqrt(S.Position.X * S.Position.X + S.Position.Y * S.Position.Y);
	CHECK(Drift < 1.0, "hold in 6 m/s wind drifted %.2f m", Drift);
}

static void WindPushesAngleMode()
{
	Model M;
	M.SetMode(FlightMode::Angle);
	M.Reset(Vec3(0, 0, 50));
	M.SetWind(Vec3(5.0, 0, 0));
	Sticks In;
	In.Throttle = M.HoverStick();
	Run(M, In, 10.0);
	CHECK(M.GetState().Position.X > 5.0, "angle mode should drift downwind, x=%.2f", M.GetState().Position.X);
}

static void GentleLandingVsCrash()
{
	Model Land;
	Land.SetGroundHeight(0.0);
	Land.Reset(Vec3(0, 0, 3));
	Sticks Down;
	Down.Throttle = -0.6;  // descend at about 2.2 m/s
	Run(Land, Down, 5.0);
	CHECK(!Land.GetState().bCrashed, "gentle descent should land, not crash");
	CHECK(std::fabs(Land.GetState().Position.Z) < 1e-6, "landed drone below ground: z=%.3f", Land.GetState().Position.Z);

	Model Fall;
	Fall.SetMode(FlightMode::Angle);
	Fall.SetGroundHeight(0.0);
	Fall.Reset(Vec3(0, 0, 20));
	Sticks Cut;
	Cut.Throttle = -1.0;  // motors off
	Run(Fall, Cut, 4.0);
	CHECK(Fall.GetState().bCrashed, "falling 20 m with motors off should crash");
	CHECK(Fall.GetState().ThrustFraction == 0.0, "crashed drone must not thrust");
}

static void TakeOffFromGround()
{
	Model M;
	M.SetGroundHeight(0.0);
	M.Reset(Vec3(0, 0, 0));
	Run(M, Sticks(), 2.0);
	CHECK(!M.GetState().bCrashed && M.GetState().Position.Z < 0.05, "idle on ground should stay put");
	Sticks Up;
	Up.Throttle = 1.0;
	Run(M, Up, 2.0);
	CHECK(M.GetState().Position.Z > 3.0, "full climb should take off, z=%.2f", M.GetState().Position.Z);
}

static void SurvivesAbuse()
{
	Model M(Fpv5InchPreset());
	M.SetMode(FlightMode::Acro);
	M.Reset(Vec3(0, 0, 100));
	Sticks In;
	for (int I = 0; I < 2000; ++I)
	{
		In.Throttle = std::sin(I * 0.37) * 2.0;  // out of range on purpose
		In.Roll = std::cos(I * 0.11) * 3.0;
		In.Pitch = std::sin(I * 0.07);
		In.Yaw = std::cos(I * 0.05);
		M.Step(In, (I % 7 == 0) ? 0.25 : 1.0 / 144.0);  // includes long frames
	}
	CHECK(Finite(M.GetState()), "state went non-finite");
	M.Step(In, -1.0);
	M.Step(In, 0.0);
	CHECK(Finite(M.GetState()), "zero or negative dt broke the state");
}

static void UnrealConversion()
{
	double Out[3];
	ToUnrealCm(Vec3(1.0, 1.0, 1.0), Out);
	CHECK(Out[0] == 100.0 && Out[1] == -100.0 && Out[2] == 100.0, "position to Unreal");
	const Vec3 Back = FromUnrealCm(Out[0], Out[1], Out[2]);
	CHECK(std::fabs(Back.X - 1.0) + std::fabs(Back.Y - 1.0) + std::fabs(Back.Z - 1.0) < 1e-12, "round trip");

	// Model heading +90 deg (turned left) must be Unreal yaw -90 deg (also left).
	double Q[4];
	ToUnrealQuatXYZW(Quat::FromAxisAngle(Vec3(0, 0, 1), kPi / 2.0), Q);
	CHECK(Q[0] == 0.0 && Q[1] == 0.0 && Q[2] < -0.7 && Q[3] > 0.7, "left turn maps to negative Unreal yaw");
	CHECK(std::fabs(HeadingFromUnrealYawDeg(90.0) + kPi / 2.0) < 1e-12, "Unreal yaw 90 = model heading -90");
}

static void PresetsAreLabelledPhysics()
{
	const Params Cam = CameraDronePreset();
	const Params Fpv = Fpv5InchPreset();
	CHECK(Cam.ThrustToWeight > 1.0 && Fpv.ThrustToWeight > Cam.ThrustToWeight, "thrust to weight ordering");
	Model M(Fpv);
	CHECK(std::fabs(M.MaxThrustN() - 6.0 * 0.65 * kGravity) < 1e-9, "max thrust");
}

int main()
{
	HoldModeHovers();
	AngleModeHoverStick();
	AngleModeTiltLimitAndForward();
	AngleModeRollRight();
	AcroRates();
	YawRightTurnsClockwise();
	HoldModeSpeedAndStop();
	HoldModeBrakesInsteadOfSpringingBack();
	HoldModeClimb();
	HoldModeFightsWind();
	WindPushesAngleMode();
	GentleLandingVsCrash();
	TakeOffFromGround();
	SurvivesAbuse();
	UnrealConversion();
	PresetsAreLabelledPhysics();
	std::printf("%d checks, %d failures\n", Checks, Failures);
	return Failures == 0 ? 0 : 1;
}
