// Writes core/fixtures/trajectory.json: three scripted flights flown by the
// C++ model. web/tests/flight.test.mjs flies the same scripts with the
// JavaScript port and must land on the same numbers.
// Regenerate: core/cpp/tests/make_fixture.sh
#include "../DroneFlightModel.h"

#include <cstdio>
#include <vector>

using namespace DroneSim;

struct Segment
{
	double Seconds;
	Sticks In;
};

struct Scenario
{
	const char* Name;
	bool bFpv;
	FlightMode Mode;
	Vec3 Start;
	Vec3 Wind;
	std::vector<Segment> Script;
};

static const char* ModeKey(FlightMode M) { return ModeName(M); }

int main()
{
	const double Dt = 1.0 / 60.0;
	std::vector<Scenario> All;
	{
		Scenario S{"hold-camera", false, FlightMode::Hold, Vec3(0, 0, 2), Vec3(1.5, -2.0, 0), {}};
		Sticks Climb;
		Climb.Throttle = 0.8;
		Sticks Forward;
		Forward.Pitch = 0.7;
		Forward.Roll = -0.3;
		Sticks Turn;
		Turn.Yaw = 0.6;
		Turn.Pitch = 0.4;
		S.Script = {{2.0, Climb}, {3.0, Forward}, {2.0, Turn}, {3.0, Sticks()}};
		All.push_back(S);
	}
	{
		Scenario S{"angle-camera", false, FlightMode::Angle, Vec3(0, 0, 40), Vec3(), {}};
		const double Hover = 2.0 / 2.2 - 1.0;
		Sticks A;
		A.Throttle = Hover + 0.1;
		A.Pitch = 0.5;
		Sticks B;
		B.Throttle = Hover;
		B.Roll = 0.8;
		B.Yaw = -0.4;
		Sticks C;
		C.Throttle = Hover - 0.05;
		S.Script = {{2.5, A}, {2.5, B}, {2.0, C}};
		All.push_back(S);
	}
	{
		Scenario S{"acro-fpv", true, FlightMode::Acro, Vec3(0, 0, 60), Vec3(0, 3.0, 0), {}};
		const double Hover = 2.0 / 6.0 - 1.0;
		Sticks Roll;
		Roll.Throttle = Hover + 0.2;
		Roll.Roll = 1.0;
		Sticks Level;
		Level.Throttle = Hover;
		Sticks Punch;
		Punch.Throttle = 0.9;
		Punch.Pitch = 0.3;
		Punch.Yaw = 0.5;
		S.Script = {{0.55, Roll}, {1.0, Level}, {1.5, Punch}, {1.0, Level}};
		All.push_back(S);
	}

	std::printf("{\n  \"generated_by\": \"core/cpp/tests/trajectory.cpp\",\n  \"dt\": %.17g,\n  \"scenarios\": [\n", Dt);
	for (size_t K = 0; K < All.size(); ++K)
	{
		const Scenario& Sc = All[K];
		Model M(Sc.bFpv ? Fpv5InchPreset() : CameraDronePreset());
		M.SetMode(Sc.Mode);
		M.SetWind(Sc.Wind);
		M.Reset(Sc.Start);
		std::printf("    {\"name\": \"%s\", \"fpv\": %s, \"mode\": \"%s\", \"start\": [%.17g, %.17g, %.17g], \"wind\": [%.17g, %.17g, %.17g],\n",
			Sc.Name, Sc.bFpv ? "true" : "false", ModeKey(Sc.Mode), Sc.Start.X, Sc.Start.Y, Sc.Start.Z, Sc.Wind.X, Sc.Wind.Y, Sc.Wind.Z);
		std::printf("     \"script\": [");
		for (size_t I = 0; I < Sc.Script.size(); ++I)
		{
			const Segment& Seg = Sc.Script[I];
			std::printf("%s{\"seconds\": %.17g, \"throttle\": %.17g, \"yaw\": %.17g, \"pitch\": %.17g, \"roll\": %.17g}",
				I ? ", " : "", Seg.Seconds, Seg.In.Throttle, Seg.In.Yaw, Seg.In.Pitch, Seg.In.Roll);
		}
		std::printf("],\n     \"samples\": [\n");
		int Frame = 0;
		bool First = true;
		for (const Segment& Seg : Sc.Script)
		{
			const int N = static_cast<int>(Seg.Seconds / Dt + 0.5);
			for (int I = 0; I < N; ++I)
			{
				M.Step(Seg.In, Dt);
				++Frame;
				if (Frame % 15 == 0)
				{
					const State& St = M.GetState();
					std::printf("%s       {\"frame\": %d, \"p\": [%.17g, %.17g, %.17g], \"v\": [%.17g, %.17g, %.17g], \"q\": [%.17g, %.17g, %.17g, %.17g]}",
						First ? "" : ",\n", Frame, St.Position.X, St.Position.Y, St.Position.Z, St.Velocity.X, St.Velocity.Y,
						St.Velocity.Z, St.Attitude.W, St.Attitude.X, St.Attitude.Y, St.Attitude.Z);
					First = false;
				}
			}
		}
		std::printf("\n     ]}%s\n", K + 1 < All.size() ? "," : "");
	}
	std::printf("  ]\n}\n");
	return 0;
}
