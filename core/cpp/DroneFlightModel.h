// DroneFlightModel.h
//
// Quadcopter flight model: what the sticks ask for, what the motors push, how
// the drone moves. Plain C++17 with no Unreal types, so the same file builds
// into the game and into the standalone tests in Tests/.
//
// Does: three flight modes (Hold = beginner, stops and hovers when the sticks
// are released; Angle = self-levelling with manual throttle; Acro = rate mode
// for FPV), total thrust, gravity, quadratic drag, wind, ground contact and
// crash detection.
// Does NOT: model single motors, propeller aerodynamics, battery sag, prop
// wash or ground effect. Preset numbers are ESTIMATES until the builder
// (milestone M3) computes them from real motor and propeller data.
//
// Frame: right-handed, x forward, y left, z up (FLU); metres, seconds,
// radians. Body rates: P rolls right when positive, Q pitches the nose down
// when positive, R turns left when positive. Unreal is left-handed (y right)
// and works in centimetres: use the conversion helpers at the bottom.
#pragma once

#include <cmath>

namespace DroneSim
{
constexpr double kGravity = 9.80665;
constexpr double kPi = 3.14159265358979323846;

// Own min/max/clamp: Windows headers define min and max as macros.
inline double MinD(double A, double B) { return A < B ? A : B; }
inline double MaxD(double A, double B) { return A > B ? A : B; }
inline double ClampD(double V, double Lo, double Hi) { return MinD(MaxD(V, Lo), Hi); }
inline double DegToRad(double Deg) { return Deg * kPi / 180.0; }
inline double RadToDeg(double Rad) { return Rad * 180.0 / kPi; }

struct Vec3
{
	double X = 0.0;
	double Y = 0.0;
	double Z = 0.0;

	Vec3() = default;
	Vec3(double InX, double InY, double InZ) : X(InX), Y(InY), Z(InZ) {}

	Vec3 operator+(const Vec3& O) const { return Vec3(X + O.X, Y + O.Y, Z + O.Z); }
	Vec3 operator-(const Vec3& O) const { return Vec3(X - O.X, Y - O.Y, Z - O.Z); }
	Vec3 operator*(double S) const { return Vec3(X * S, Y * S, Z * S); }
	Vec3 operator-() const { return Vec3(-X, -Y, -Z); }
	Vec3& operator+=(const Vec3& O)
	{
		X += O.X;
		Y += O.Y;
		Z += O.Z;
		return *this;
	}
	double Dot(const Vec3& O) const { return X * O.X + Y * O.Y + Z * O.Z; }
	Vec3 Cross(const Vec3& O) const { return Vec3(Y * O.Z - Z * O.Y, Z * O.X - X * O.Z, X * O.Y - Y * O.X); }
	double Length() const { return std::sqrt(Dot(*this)); }
	Vec3 Normalized() const
	{
		const double Len = Length();
		return Len > 1e-12 ? *this * (1.0 / Len) : Vec3(0.0, 0.0, 1.0);
	}
};

struct Quat
{
	double W = 1.0;
	double X = 0.0;
	double Y = 0.0;
	double Z = 0.0;

	Quat() = default;
	Quat(double InW, double InX, double InY, double InZ) : W(InW), X(InX), Y(InY), Z(InZ) {}

	static Quat FromAxisAngle(const Vec3& Axis, double AngleRad)
	{
		const Vec3 A = Axis.Normalized();
		const double S = std::sin(AngleRad * 0.5);
		return Quat(std::cos(AngleRad * 0.5), A.X * S, A.Y * S, A.Z * S);
	}

	// Rotation whose columns are the body axes expressed in the world frame.
	static Quat FromAxes(const Vec3& Xb, const Vec3& Yb, const Vec3& Zb)
	{
		const double M00 = Xb.X, M01 = Yb.X, M02 = Zb.X;
		const double M10 = Xb.Y, M11 = Yb.Y, M12 = Zb.Y;
		const double M20 = Xb.Z, M21 = Yb.Z, M22 = Zb.Z;
		const double Trace = M00 + M11 + M22;
		Quat Out;
		if (Trace > 0.0)
		{
			const double S = std::sqrt(Trace + 1.0) * 2.0;
			Out = Quat(0.25 * S, (M21 - M12) / S, (M02 - M20) / S, (M10 - M01) / S);
		}
		else if (M00 > M11 && M00 > M22)
		{
			const double S = std::sqrt(1.0 + M00 - M11 - M22) * 2.0;
			Out = Quat((M21 - M12) / S, 0.25 * S, (M01 + M10) / S, (M02 + M20) / S);
		}
		else if (M11 > M22)
		{
			const double S = std::sqrt(1.0 + M11 - M00 - M22) * 2.0;
			Out = Quat((M02 - M20) / S, (M01 + M10) / S, 0.25 * S, (M12 + M21) / S);
		}
		else
		{
			const double S = std::sqrt(1.0 + M22 - M00 - M11) * 2.0;
			Out = Quat((M10 - M01) / S, (M02 + M20) / S, (M12 + M21) / S, 0.25 * S);
		}
		return Out.Normalized();
	}

	Quat operator*(const Quat& O) const
	{
		return Quat(W * O.W - X * O.X - Y * O.Y - Z * O.Z,
			W * O.X + X * O.W + Y * O.Z - Z * O.Y,
			W * O.Y - X * O.Z + Y * O.W + Z * O.X,
			W * O.Z + X * O.Y - Y * O.X + Z * O.W);
	}
	Quat Conjugate() const { return Quat(W, -X, -Y, -Z); }
	Quat Normalized() const
	{
		const double Len = std::sqrt(W * W + X * X + Y * Y + Z * Z);
		return Len > 1e-12 ? Quat(W / Len, X / Len, Y / Len, Z / Len) : Quat();
	}
	// Rotates a body-frame vector into the world frame.
	Vec3 Rotate(const Vec3& V) const
	{
		const Vec3 U(X, Y, Z);
		const Vec3 T = U.Cross(V) * 2.0;
		return V + T * W + U.Cross(T);
	}
};

enum class FlightMode
{
	Hold,
	Angle,
	Acro
};

inline const char* ModeName(FlightMode Mode)
{
	switch (Mode)
	{
	case FlightMode::Hold:
		return "Hold";
	case FlightMode::Angle:
		return "Angle";
	case FlightMode::Acro:
		return "Acro";
	}
	return "?";
}

// All values are ESTIMATES for a playable first version. The builder (M3)
// replaces them with numbers computed from real parts.
struct Params
{
	const char* Name = "Camera drone";
	double MassKg = 0.9;
	double ThrustToWeight = 2.2;      // maximum total thrust divided by weight
	double DragCoeff = 0.03;          // N per (m/s)^2
	double MaxTiltDeg = 30.0;         // Hold and Angle modes
	double MaxRateDegPerS = 200.0;    // Acro roll and pitch
	double MaxYawRateDegPerS = 100.0;
	double RateTimeConstantS = 0.12;  // how quickly the drone reaches a commanded rotation rate
	double AttitudeGain = 6.0;        // 1/s: attitude error to rate command
	double HoldMaxSpeedMs = 12.0;
	double HoldMaxClimbMs = 4.0;
	double CrashSpeedMs = 4.0;        // touching anything faster than this is a crash
	double StickDeadband = 0.05;
	double AcroExpo = 0.3;
};

inline Params CameraDronePreset() { return Params(); }

inline Params Fpv5InchPreset()
{
	Params P;
	P.Name = "FPV 5-inch";
	P.MassKg = 0.65;
	P.ThrustToWeight = 6.0;
	P.DragCoeff = 0.04;
	P.MaxTiltDeg = 55.0;
	P.MaxRateDegPerS = 670.0;
	P.MaxYawRateDegPerS = 400.0;
	P.RateTimeConstantS = 0.04;
	P.AttitudeGain = 10.0;
	P.HoldMaxSpeedMs = 20.0;
	P.HoldMaxClimbMs = 8.0;
	P.CrashSpeedMs = 6.0;
	return P;
}

// Stick positions, each in [-1, 1]. Throttle -1 = stick fully down.
// Pitch +1 = stick forward, Roll +1 = right, Yaw +1 = right.
struct Sticks
{
	double Throttle = 0.0;
	double Yaw = 0.0;
	double Pitch = 0.0;
	double Roll = 0.0;
};

struct State
{
	Vec3 Position;   // metres from the start point
	Vec3 Velocity;   // m/s, world frame
	Quat Attitude;   // body to world
	Vec3 BodyRates;  // rad/s, body frame (P, Q, R)
	bool bCrashed = false;
	bool bOnGround = false;
	double ThrustFraction = 0.0;  // 0..1 of maximum thrust
};

class Model
{
public:
	explicit Model(const Params& InParams = CameraDronePreset()) : P(InParams) {}

	void SetParams(const Params& InParams) { P = InParams; }
	const Params& GetParams() const { return P; }

	void SetMode(FlightMode InMode)
	{
		Mode = InMode;
		ClearHold();
	}
	FlightMode GetMode() const { return Mode; }

	void SetWind(const Vec3& InWind) { Wind = InWind; }

	// Flat ground at this height. The game does not use it: it reports real
	// terrain through Contact(). Tests use it.
	void SetGroundHeight(double Height)
	{
		GroundZ = Height;
		bHasGround = true;
	}

	void Reset(const Vec3& Position = Vec3(), double HeadingRad = 0.0)
	{
		S = State();
		S.Position = Position;
		S.Attitude = Quat::FromAxisAngle(Vec3(0.0, 0.0, 1.0), HeadingRad);
		ClearHold();
	}

	const State& GetState() const { return S; }

	double MaxThrustN() const { return P.ThrustToWeight * P.MassKg * kGravity; }

	// Throttle stick position ([-1, 1]) that hovers in Angle or Acro mode.
	double HoverStick() const { return 2.0 / P.ThrustToWeight - 1.0; }

	// Heading in radians: 0 = start direction, positive = turned left.
	double Heading() const
	{
		const Vec3 Fwd = S.Attitude.Rotate(Vec3(1.0, 0.0, 0.0));
		if (std::fabs(Fwd.X) + std::fabs(Fwd.Y) < 1e-6)
		{
			const Vec3 Up = S.Attitude.Rotate(Vec3(0.0, 0.0, 1.0));
			return std::atan2(-Up.Y, -Up.X);
		}
		return std::atan2(Fwd.Y, Fwd.X);
	}

	double TiltDeg() const
	{
		const Vec3 Up = S.Attitude.Rotate(Vec3(0.0, 0.0, 1.0));
		return RadToDeg(std::acos(ClampD(Up.Z, -1.0, 1.0)));
	}

	// Advances the simulation; splits long frames into small fixed steps.
	void Step(const Sticks& In, double Dt)
	{
		if (!(Dt > 0.0))
		{
			return;
		}
		const double MaxStep = 1.0 / 240.0;
		int Count = static_cast<int>(std::ceil(Dt / MaxStep));
		if (Count > 120)
		{
			Count = 120;  // never simulate more than half a second per frame
		}
		const double Sub = MinD(Dt, 0.5) / Count;
		for (int I = 0; I < Count; ++I)
		{
			SubStep(In, Sub);
		}
	}

	// Called when something (terrain, a building) stopped the drone.
	// StoppedAt: where it stopped (metres, model frame). Normal: surface normal.
	void Contact(const Vec3& StoppedAt, const Vec3& Normal)
	{
		const Vec3 N = Normal.Normalized();
		const double IntoSurface = -S.Velocity.Dot(N);
		S.Position = StoppedAt;
		if (IntoSurface > P.CrashSpeedMs)
		{
			S.bCrashed = true;
			S.Velocity = Vec3();
			S.BodyRates = Vec3();
			S.ThrustFraction = 0.0;
			return;
		}
		if (IntoSurface > 0.0)
		{
			S.Velocity += N * IntoSurface;
		}
		S.Velocity = S.Velocity * 0.8;  // friction while touching
		S.bOnGround = N.Z > 0.5;
		if (S.bOnGround)
		{
			// Landed: stop rotating and settle level, keeping the heading.
			S.BodyRates = Vec3();
			S.Attitude = Quat::FromAxisAngle(Vec3(0.0, 0.0, 1.0), Heading());
		}
	}

private:
	static double Deadband(double V, double Band)
	{
		if (std::fabs(V) <= Band)
		{
			return 0.0;
		}
		const double Sign = V > 0.0 ? 1.0 : -1.0;
		return Sign * (std::fabs(V) - Band) / (1.0 - Band);
	}

	void ClearHold()
	{
		bHoldPosition = false;
		bHoldAltitude = false;
		VelocityIntegral = Vec3();
	}

	// Desired body attitude from a desired thrust direction (world) and heading.
	static Quat AttitudeFrom(const Vec3& ThrustDir, double HeadingRad)
	{
		const Vec3 Zb = ThrustDir.Normalized();
		const Vec3 Xc(std::cos(HeadingRad), std::sin(HeadingRad), 0.0);
		Vec3 Yb = Zb.Cross(Xc);
		if (Yb.Length() < 1e-6)
		{
			Yb = Vec3(-std::sin(HeadingRad), std::cos(HeadingRad), 0.0);
		}
		Yb = Yb.Normalized();
		const Vec3 Xb = Yb.Cross(Zb);
		return Quat::FromAxes(Xb, Yb, Zb);
	}

	Vec3 RateFromAttitudeError(const Quat& Desired, double YawRate) const
	{
		Quat Err = S.Attitude.Conjugate() * Desired;
		if (Err.W < 0.0)
		{
			Err = Quat(-Err.W, -Err.X, -Err.Y, -Err.Z);
		}
		const double Limit = DegToRad(MaxD(P.MaxRateDegPerS, 300.0));
		const double Gain = 2.0 * P.AttitudeGain;
		return Vec3(ClampD(Gain * Err.X, -Limit, Limit), ClampD(Gain * Err.Y, -Limit, Limit), YawRate);
	}

	void SubStep(const Sticks& Raw, double Dt)
	{
		const double Mass = P.MassKg;
		const Vec3 GravityAcc(0.0, 0.0, -kGravity);
		double ThrustN = 0.0;

		if (!S.bCrashed)
		{
			Sticks In;
			In.Throttle = Deadband(ClampD(Raw.Throttle, -1.0, 1.0), P.StickDeadband);
			In.Yaw = Deadband(ClampD(Raw.Yaw, -1.0, 1.0), P.StickDeadband);
			In.Pitch = Deadband(ClampD(Raw.Pitch, -1.0, 1.0), P.StickDeadband);
			In.Roll = Deadband(ClampD(Raw.Roll, -1.0, 1.0), P.StickDeadband);

			const double Psi = Heading();
			const double YawRate = -In.Yaw * DegToRad(P.MaxYawRateDegPerS);
			const double Throttle01 = (ClampD(Raw.Throttle, -1.0, 1.0) + 1.0) * 0.5;
			Vec3 RateCmd;

			if (Mode == FlightMode::Acro)
			{
				const double E = P.AcroExpo;
				const double Rate = DegToRad(P.MaxRateDegPerS);
				const double RollC = In.Roll * (1.0 - E) + In.Roll * In.Roll * In.Roll * E;
				const double PitchC = In.Pitch * (1.0 - E) + In.Pitch * In.Pitch * In.Pitch * E;
				RateCmd = Vec3(RollC * Rate, PitchC * Rate, YawRate);
				ThrustN = Throttle01 * MaxThrustN();
			}
			else if (Mode == FlightMode::Angle)
			{
				const double Tilt = DegToRad(P.MaxTiltDeg);
				const Quat Level = Quat::FromAxisAngle(Vec3(0.0, 0.0, 1.0), Psi);
				const Quat Tilted = Level * Quat::FromAxisAngle(Vec3(0.0, 1.0, 0.0), In.Pitch * Tilt)
					* Quat::FromAxisAngle(Vec3(1.0, 0.0, 0.0), In.Roll * Tilt);
				const Vec3 ThrustDir = Tilted.Rotate(Vec3(0.0, 0.0, 1.0));
				RateCmd = RateFromAttitudeError(AttitudeFrom(ThrustDir, Psi), YawRate);
				ThrustN = Throttle01 * MaxThrustN();
			}
			else
			{
				ThrustN = HoldControl(In, Psi, Dt, RateCmd, YawRate);
			}

			const double Alpha = Dt / (P.RateTimeConstantS + Dt);
			S.BodyRates += (RateCmd - S.BodyRates) * Alpha;
		}

		// Attitude: q' = q * exp(w dt / 2)
		const Vec3 W = S.BodyRates;
		const double Angle = W.Length() * Dt;
		if (Angle > 1e-12)
		{
			S.Attitude = (S.Attitude * Quat::FromAxisAngle(W, Angle)).Normalized();
		}

		// Forces
		const Vec3 Thrust = S.Attitude.Rotate(Vec3(0.0, 0.0, ThrustN));
		const Vec3 Air = S.Velocity - Wind;
		const Vec3 Drag = Air * (-P.DragCoeff * Air.Length());
		const Vec3 Acc = (Thrust + Drag) * (1.0 / Mass) + GravityAcc;
		S.Velocity += Acc * Dt;
		S.Position += S.Velocity * Dt;
		S.ThrustFraction = S.bCrashed ? 0.0 : ThrustN / MaxThrustN();
		S.bOnGround = false;

		if (bHasGround && S.Position.Z < GroundZ)
		{
			Contact(Vec3(S.Position.X, S.Position.Y, GroundZ), Vec3(0.0, 0.0, 1.0));
		}
	}

	// Hold mode: sticks command speeds; released sticks hold position and height.
	double HoldControl(const Sticks& In, double Psi, double Dt, Vec3& RateCmd, double YawRate)
	{
		const double KPos = 1.0;
		const double KVel = 2.5;
		const double KInt = 0.6;
		const double IntLimit = 6.0;

		const Vec3 Fwd(std::cos(Psi), std::sin(Psi), 0.0);
		const Vec3 Left(-std::sin(Psi), std::cos(Psi), 0.0);
		Vec3 VelCmd = Fwd * (In.Pitch * P.HoldMaxSpeedMs) + Left * (-In.Roll * P.HoldMaxSpeedMs);

		// Released sticks: brake to a stop first, then hold where it stopped
		// (no spring back to the point where the stick was let go).
		if (In.Pitch == 0.0 && In.Roll == 0.0)
		{
			const double GroundSpeed = std::sqrt(S.Velocity.X * S.Velocity.X + S.Velocity.Y * S.Velocity.Y);
			if (!bHoldPosition && GroundSpeed < 0.5)
			{
				HoldXY = Vec3(S.Position.X, S.Position.Y, 0.0);
				bHoldPosition = true;
			}
			VelCmd = Vec3();
			if (bHoldPosition)
			{
				const Vec3 Err(HoldXY.X - S.Position.X, HoldXY.Y - S.Position.Y, 0.0);
				VelCmd = Err * KPos;
				const double Len = VelCmd.Length();
				if (Len > P.HoldMaxSpeedMs)
				{
					VelCmd = VelCmd * (P.HoldMaxSpeedMs / Len);
				}
			}
		}
		else
		{
			bHoldPosition = false;
		}

		if (In.Throttle == 0.0)
		{
			if (!bHoldAltitude && std::fabs(S.Velocity.Z) < 0.3)
			{
				HoldZ = S.Position.Z;
				bHoldAltitude = true;
			}
			VelCmd.Z = bHoldAltitude ? ClampD((HoldZ - S.Position.Z) * KPos, -P.HoldMaxClimbMs, P.HoldMaxClimbMs) : 0.0;
		}
		else
		{
			bHoldAltitude = false;
			VelCmd.Z = In.Throttle * P.HoldMaxClimbMs;
		}

		const Vec3 VelErr = VelCmd - S.Velocity;
		if (!S.bOnGround)
		{
			VelocityIntegral += VelErr * Dt;
		}
		VelocityIntegral = Vec3(ClampD(VelocityIntegral.X, -IntLimit, IntLimit),
			ClampD(VelocityIntegral.Y, -IntLimit, IntLimit), ClampD(VelocityIntegral.Z, -IntLimit, IntLimit));

		const Vec3 AccCmd = VelErr * KVel + VelocityIntegral * KInt;
		Vec3 Force = (AccCmd + Vec3(0.0, 0.0, kGravity)) * P.MassKg;

		// Keep thrust upward and inside the tilt limit.
		Force.Z = MaxD(Force.Z, 0.2 * P.MassKg * kGravity);
		const double MaxH = Force.Z * std::tan(DegToRad(P.MaxTiltDeg));
		const double H = std::sqrt(Force.X * Force.X + Force.Y * Force.Y);
		if (H > MaxH)
		{
			Force.X *= MaxH / H;
			Force.Y *= MaxH / H;
		}

		RateCmd = RateFromAttitudeError(AttitudeFrom(Force, Psi), YawRate);
		const double Tilt = std::acos(ClampD(S.Attitude.Rotate(Vec3(0.0, 0.0, 1.0)).Z, -1.0, 1.0));
		// Thrust along the current body axis that gives the wanted vertical force.
		const double Needed = Force.Z / MaxD(std::cos(Tilt), 0.3);
		return ClampD(Needed, 0.0, MaxThrustN());
	}

	Params P;
	FlightMode Mode = FlightMode::Hold;
	State S;
	Vec3 Wind;
	double GroundZ = 0.0;
	bool bHasGround = false;
	bool bHoldPosition = false;
	bool bHoldAltitude = false;
	Vec3 HoldXY;
	double HoldZ = 0.0;
	Vec3 VelocityIntegral;
};

// --- Unreal conversion -------------------------------------------------------
// Unreal: left-handed, x forward, y right, z up, centimetres.

inline void ToUnrealCm(const Vec3& V, double Out[3])
{
	Out[0] = V.X * 100.0;
	Out[1] = -V.Y * 100.0;
	Out[2] = V.Z * 100.0;
}

inline Vec3 FromUnrealCm(double X, double Y, double Z) { return Vec3(X / 100.0, -Y / 100.0, Z / 100.0); }

inline Vec3 FromUnrealDirection(double X, double Y, double Z) { return Vec3(X, -Y, Z); }

// Mirroring the y axis flips the sense of rotations about x and z.
inline void ToUnrealQuatXYZW(const Quat& Q, double Out[4])
{
	Out[0] = -Q.X;
	Out[1] = Q.Y;
	Out[2] = -Q.Z;
	Out[3] = Q.W;
}

// Unreal yaw (degrees, positive turns right) to model heading (radians, positive turns left).
inline double HeadingFromUnrealYawDeg(double YawDeg) { return -DegToRad(YawDeg); }

}  // namespace DroneSim
